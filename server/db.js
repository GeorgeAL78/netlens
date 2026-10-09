import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { dbFile, databaseDir } from "./paths.js";

const db = new DatabaseSync(dbFile);
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    mac TEXT PRIMARY KEY,
    id TEXT,
    name TEXT,
    hostname TEXT,
    ip TEXT,
    type TEXT,
    last_seen INTEGER,
    blocked INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS usage_samples (
    ts INTEGER NOT NULL,
    ts_end INTEGER NOT NULL,
    mac TEXT NOT NULL,
    app_id INTEGER NOT NULL,
    cat_id INTEGER NOT NULL,
    bytes_rx INTEGER NOT NULL,
    bytes_tx INTEGER NOT NULL,
    activity_seconds INTEGER NOT NULL,
    PRIMARY KEY (ts, mac, app_id)
  );
  CREATE INDEX IF NOT EXISTS usage_mac_ts ON usage_samples (mac, ts);
  CREATE TABLE IF NOT EXISTS dpi_apps (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS dpi_cats (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  -- Events from UniFi's SIEM / syslog export (server/siem.js). uid is a hash of the raw
  -- payload, so a replayed or re-read line is stored once.
  CREATE TABLE IF NOT EXISTS siem_events (
    uid TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    name TEXT,
    category TEXT,
    mac TEXT,
    data TEXT
  );
  CREATE INDEX IF NOT EXISTS siem_ts ON siem_events (ts);
  -- Live samples every 5 minutes (server/health.js, UU-C-056), kept 90 days.
  CREATE TABLE IF NOT EXISTS client_samples (
    ts INTEGER NOT NULL,
    mac TEXT NOT NULL,
    wired INTEGER,
    ap_mac TEXT,
    radio TEXT,
    channel INTEGER,
    width INTEGER,
    essid TEXT,
    signal INTEGER,
    noise INTEGER,
    tx_rate INTEGER,
    rx_rate INTEGER,
    satisfaction INTEGER,
    tx_retries INTEGER,
    tx_attempts INTEGER,
    PRIMARY KEY (mac, ts)
  );
  CREATE INDEX IF NOT EXISTS client_samples_ts ON client_samples (ts);
  CREATE TABLE IF NOT EXISTS device_samples (
    ts INTEGER NOT NULL,
    mac TEXT NOT NULL,
    name TEXT,
    type TEXT,
    model TEXT,
    state INTEGER,
    cpu REAL,
    mem REAL,
    temp REAL,
    uptime INTEGER,
    clients INTEGER,
    data TEXT,
    PRIMARY KEY (mac, ts)
  );
  -- IPS signature per "Threat blocked" event (UU-C-071), keyed by the siem_events uid.
  -- found = 0: looked up and not (yet) found; retried while the console still has flows.
  CREATE TABLE IF NOT EXISTS ips_details (
    uid TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    found INTEGER NOT NULL,
    data TEXT,
    checked_at INTEGER NOT NULL
  );
  -- Names for local MACs and IPs that are not current clients (UU-F-052): UniFi devices by
  -- every interface MAC and network address, and known (also offline) clients. Rebuilt
  -- from UniFi by health.refreshLocalNames; read by the report to name LAN destinations.
  CREATE TABLE IF NOT EXISTS local_names (
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    source TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (source, key)
  );
  -- UniFi's per-device daily totals (stat/report/daily.user), kept a year (UU-C-057).
  CREATE TABLE IF NOT EXISTS daily_device (
    day TEXT NOT NULL,
    mac TEXT NOT NULL,
    rx INTEGER,
    tx INTEGER,
    PRIMARY KEY (day, mac)
  );
  CREATE TABLE IF NOT EXISTS wan_samples (
    ts INTEGER PRIMARY KEY,
    status TEXT,
    isp TEXT,
    latency REAL,
    availability REAL,
    drops INTEGER,
    rx_rate REAL,
    tx_rate REAL,
    data TEXT
  );
  CREATE INDEX IF NOT EXISTS siem_mac_ts ON siem_events (mac, ts);
`);

const upsertClient = db.prepare(`
  INSERT INTO clients (mac, id, name, hostname, ip, type, last_seen, blocked)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(mac) DO UPDATE SET
    id = COALESCE(excluded.id, clients.id),
    name = COALESCE(excluded.name, clients.name),
    hostname = COALESCE(excluded.hostname, clients.hostname),
    ip = COALESCE(excluded.ip, clients.ip),
    type = COALESCE(excluded.type, clients.type),
    last_seen = MAX(clients.last_seen, excluded.last_seen),
    blocked = excluded.blocked
`);

const insertSample = db.prepare(`
  INSERT INTO usage_samples (ts, ts_end, mac, app_id, cat_id, bytes_rx, bytes_tx, activity_seconds)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(ts, mac, app_id) DO UPDATE SET
    ts_end = excluded.ts_end,
    cat_id = excluded.cat_id,
    bytes_rx = excluded.bytes_rx,
    bytes_tx = excluded.bytes_tx,
    activity_seconds = excluded.activity_seconds
`);

const upsertApp = db.prepare(`INSERT INTO dpi_apps (id, name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name`);
const upsertCat = db.prepare(`INSERT INTO dpi_cats (id, name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name`);
const setMeta = db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
const getMeta = db.prepare(`SELECT value FROM meta WHERE key = ?`);
const setSettingStmt = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
const getSettingStmt = db.prepare(`SELECT value FROM settings WHERE key = ?`);

export function getSetting(key, fallback = null) {
  const row = getSettingStmt.get(key);
  if (row?.value == null || row.value === "") return fallback;
  return row.value;
}

export function setSetting(key, value) {
  if (value == null) return;
  setSettingStmt.run(key, String(value));
}

function seedSetting(key, value) {
  if (value == null || value === "") return;
  if (getSetting(key) == null) setSetting(key, value);
}

seedSetting("unifi_host", process.env.UNIFI_HOST || "192.168.1.1");
seedSetting("unifi_api_key", process.env.UNIFI_API_KEY);
seedSetting("unifi_site_id", process.env.UNIFI_SITE_ID);
seedSetting("unifi_site", process.env.UNIFI_SITE || "default");
seedSetting("port", process.env.PORT || "3780");
// Only an explicit TZ is stored; otherwise index.js falls back to the system timezone.
// Defaulting to America/New_York here overrode that fallback on every fresh install.
seedSetting("tz", process.env.TZ);
seedSetting("snapshot_minutes", process.env.SNAPSHOT_MINUTES || "5");

export const settingsFile = path.join(databaseDir, "unifi-settings.json");

function normalizeHost(host) {
  return String(host || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "");
}

export function applyConnectionSettings({ host, apiKey, site, siteId, trayMode, siemPort, tz } = {}) {
  if (tz) setSetting("tz", String(tz).trim());
  // Empty string clears these; undefined leaves them alone (v2's settings form omits them).
  if (siemPort != null) {
    const n = Number(siemPort);
    setSetting("siem_port", Number.isInteger(n) && n > 0 && n < 65536 ? String(n) : "");
  }
  if (host) setSetting("unifi_host", normalizeHost(host));
  if (apiKey != null && apiKey !== "") setSetting("unifi_api_key", String(apiKey).trim());
  if (site) setSetting("unifi_site", String(site).trim() || "default");
  if (siteId) setSetting("unifi_site_id", String(siteId).trim());
  if (trayMode != null) setSetting("tray_mode", trayMode ? "1" : "0");
}

export function readConnectionSettings() {
  return {
    host: getSetting("unifi_host", "192.168.1.1"),
    apiKey: getSetting("unifi_api_key", ""),
    site: getSetting("unifi_site", "default"),
    siteId: getSetting("unifi_site_id", ""),
    trayMode: getSetting("tray_mode", "0") === "1",
    siemPort: getSetting("siem_port", ""),
  };
}

// Never hand the API key back over HTTP. The UI only needs to know whether one is
// stored, so it can decide between "required" and "leave blank to keep".
export function publicConnectionSettings() {
  const s = readConnectionSettings();
  return {
    host: s.host,
    site: s.site,
    siteId: s.siteId,
    trayMode: s.trayMode,
    siemPort: s.siemPort,
    hasApiKey: Boolean(s.apiKey),
  };
}

export function persistConnectionFile(settings) {
  const data = {
    host: settings.host || getSetting("unifi_host", "192.168.1.1"),
    apiKey: settings.apiKey || getSetting("unifi_api_key", ""),
    site: settings.site || getSetting("unifi_site", "default"),
  };
  fs.writeFileSync(settingsFile, `${JSON.stringify(data, null, 2)}\n`);
}

try {
  if (fs.existsSync(settingsFile)) {
    const parsed = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    applyConnectionSettings(parsed);
  }
} catch {
  /* ignore bad settings file */
}

export function saveClients(clients) {
  for (const c of clients) {
    if (!c.mac) continue;
    upsertClient.run(
      c.mac,
      c.id ?? null,
      c.name ?? null,
      c.hostname ?? null,
      c.ip ?? null,
      c.type ?? null,
      c.lastSeen ?? Date.now(),
      c.blocked ? 1 : 0
    );
  }
}

export function saveSamples(ts, tsEnd, rows) {
  for (const r of rows) {
    insertSample.run(ts, tsEnd, r.mac, r.appId, r.catId, r.bytesRx, r.bytesTx, r.activitySeconds);
  }
}

export function saveDpi(apps, cats) {
  for (const a of apps) upsertApp.run(a.id, a.name);
  for (const c of cats) upsertCat.run(c.id, c.name);
}

export function listStoredClients() {
  return db.prepare(`SELECT mac, id, name, hostname, ip, type, last_seen AS lastSeen, blocked FROM clients ORDER BY name COLLATE NOCASE`).all();
}

export function dpiMaps() {
  const apps = Object.fromEntries(db.prepare(`SELECT id, name FROM dpi_apps`).all().map((r) => [r.id, r.name]));
  const cats = Object.fromEntries(db.prepare(`SELECT id, name FROM dpi_cats`).all().map((r) => [r.id, r.name]));
  return { apps, cats };
}

export function querySamples(start, end, mac) {
  if (mac) {
    return db.prepare(
      `SELECT ts, ts_end AS tsEnd, mac, app_id AS appId, cat_id AS catId, bytes_rx AS bytesRx, bytes_tx AS bytesTx, activity_seconds AS activitySeconds
       FROM usage_samples WHERE ts >= ? AND ts < ? AND mac = ?`
    ).all(start, end, mac);
  }
  return db.prepare(
    `SELECT ts, ts_end AS tsEnd, mac, app_id AS appId, cat_id AS catId, bytes_rx AS bytesRx, bytes_tx AS bytesTx, activity_seconds AS activitySeconds
     FROM usage_samples WHERE ts >= ? AND ts < ?`
  ).all(start, end);
}

export function metaGet(key) {
  return getMeta.get(key)?.value ?? null;
}

export function metaSet(key, value) {
  setMeta.run(key, String(value));
}

try {
  db.exec(`DROP TABLE IF EXISTS alert_events; DROP TABLE IF EXISTS alert_rules;`);
} catch {
  /* ignore */
}

export function searchApps(query, limit = 40) {
  if (query) {
    const safe = query.replace(/[%_]/g, "").slice(0, 40);
    return db.prepare(
      `SELECT MAX(id) AS id, name FROM dpi_apps WHERE name LIKE ? COLLATE NOCASE GROUP BY name COLLATE NOCASE ORDER BY name LIMIT ?`
    ).all(`%${safe}%`, limit);
  }
  return db.prepare(`
    SELECT MAX(id) AS id, name FROM dpi_apps
    WHERE name IN ('Youtube','Netflix','Disney+','Hulu','Twitch','TikTok','Instagram','Facebook','Spotify','iTunes/App Store','Amazon Video','HBO Max')
    GROUP BY name COLLATE NOCASE
    ORDER BY name
  `).all();
}

export { db };

const insertSiem = db.prepare(
  `INSERT OR IGNORE INTO siem_events (uid, ts, kind, name, category, mac, data) VALUES (?, ?, ?, ?, ?, ?, ?)`
);
const replaceSiem = db.prepare(
  `INSERT OR REPLACE INTO siem_events (uid, ts, kind, name, category, mac, data) VALUES (?, ?, ?, ?, ?, ?, ?)`
);

export function saveSiemEvents(rows, { replace = false } = {}) {
  let added = 0;
  const stmt = replace ? replaceSiem : insertSiem;
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      added += stmt.run(r.uid, r.ts, r.kind, r.name || null, r.category || null, r.mac || null, JSON.stringify(r.data || {})).changes;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return added;
}

export function querySiemEvents(start, end, mac) {
  const sql = `SELECT uid, ts, kind, name, category, mac, data FROM siem_events WHERE ts >= ? AND ts < ?${mac ? " AND mac = ?" : ""} ORDER BY ts DESC`;
  return (mac ? db.prepare(sql).all(start, end, mac) : db.prepare(sql).all(start, end)).map((r) => ({
    ...r,
    data: JSON.parse(r.data || "{}"),
  }));
}

// System Log connects / roams / disconnects in [since, before), oldest first, optionally for
// one device — where devices were attached on days NetLens took no samples (UU-C-102).
export function linkEvents(since, before, mac = null) {
  const sql = `SELECT mac, ts, data FROM siem_events WHERE kind = 'log' AND mac IS NOT NULL AND ts >= ? AND ts < ?${mac ? " AND mac = ?" : ""}
    AND json_extract(data, '$.key') GLOB 'CLIENT_*' AND (json_extract(data, '$.key') GLOB '*CONNECTED*' OR json_extract(data, '$.key') GLOB '*ROAMED*') ORDER BY ts`;
  return (mac ? db.prepare(sql).all(since, before, mac) : db.prepare(sql).all(since, before)).map((r) => ({ ...r, data: JSON.parse(r.data || "{}") }));
}

export function siemStats() {
  return db.prepare(`SELECT COUNT(*) AS events, MAX(ts) AS newest, MIN(ts) AS oldest FROM siem_events`).get();
}

export function pruneSiemEvents(before) {
  db.prepare(`DELETE FROM ips_details WHERE ts < ?`).run(before);
  return db.prepare(`DELETE FROM siem_events WHERE ts < ?`).run(before).changes;
}

// Names the SIEM events carry for MACs: client aliases (e.g. Unraid containers) and the
// UniFi switches/APs/gateway they connected through. Recent events win.
export function siemNamesByMac(limit = 5000) {
  const rows = db.prepare(`SELECT mac, data FROM siem_events WHERE kind = 'cef' ORDER BY ts DESC LIMIT ?`).all(limit);
  const out = new Map();
  for (const r of rows) {
    const d = JSON.parse(r.data || "{}");
    const pairs = [
      [r.mac, d.clientAlias || d.clientHostname],
      [String(d.lastConnectedToDeviceMac || "").toLowerCase(), d.lastConnectedToDeviceName],
    ];
    for (const [m, n] of pairs) if (m && n && !out.has(m)) out.set(m, n);
  }
  return out;
}

// History that travels in an export (UU-C-066). Never settings: the API key and the login
// password stay with the installation that owns them.
export const HISTORY_TABLES = ["clients", "siem_events", "ips_details", "daily_device", "client_samples", "device_samples", "wan_samples"];

// Security events (IPS threats and firewall blocks) from the last `sinceMs` without their
// connection detail yet, oldest first; ones looked up and not found are retried at most hourly,
// and ones saved in an older detail format are read again while the console still has them.
export function pendingIpsLookups(sinceMs, limit = 20, now = Date.now(), version = 2) {
  return db
    .prepare(
      `SELECT e.uid, e.ts, e.data FROM siem_events e LEFT JOIN ips_details d ON d.uid = e.uid
       WHERE e.kind = 'log' AND e.ts >= ?
         AND (e.data LIKE '%"key":"THREAT_%' OR e.data LIKE '%"key":"TRAFFIC_BLOCKED%')
         AND (d.uid IS NULL OR (d.found = 0 AND d.checked_at < ?) OR (d.found = 1 AND d.data NOT LIKE ?))
       ORDER BY e.ts LIMIT ?`
    )
    .all(sinceMs, now - 3600000, `%"v":${version}%`, limit)
    .map((r) => ({ uid: r.uid, ts: r.ts, data: JSON.parse(r.data || "{}") }));
}

export function saveIpsDetail(uid, ts, detail, now = Date.now()) {
  db.prepare(
    `INSERT INTO ips_details (uid, ts, found, data, checked_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(uid) DO UPDATE SET found = excluded.found, data = excluded.data, checked_at = excluded.checked_at`
  ).run(uid, ts, detail ? 1 : 0, detail ? JSON.stringify(detail) : null, now);
}

export function ipsDetails(start, end) {
  return new Map(
    db.prepare(`SELECT uid, data FROM ips_details WHERE found = 1 AND ts >= ? AND ts < ?`).all(start, end).map((r) => [r.uid, JSON.parse(r.data)])
  );
}

export function* exportTable(name, chunk = 5000) {
  if (!HISTORY_TABLES.includes(name)) throw new Error(`not exportable: ${name}`);
  let rows = [];
  for (const row of db.prepare(`SELECT * FROM ${name}`).iterate()) {
    rows.push(row);
    if (rows.length >= chunk) {
      yield rows;
      rows = [];
    }
  }
  if (rows.length) yield rows;
}

// Rows already present (same primary key) are left alone. Columns are taken from the
// table itself, never from the file, so a crafted file cannot name a column.
export function importRows(name, rows) {
  if (!HISTORY_TABLES.includes(name)) return 0;
  const cols = db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name);
  const ins = db.prepare(`INSERT OR IGNORE INTO ${name} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
  let added = 0;
  db.exec("BEGIN");
  try {
    for (const r of rows || []) {
      if (!r || typeof r !== "object") continue;
      const vals = cols.map((c) => {
        const v = r[c];
        if (typeof v === "boolean") return v ? 1 : 0;
        return typeof v === "number" || typeof v === "string" ? v : null;
      });
      added += Number(ins.run(...vals).changes);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return added;
}

// Devices this installation first sampled at or after `since` (UU-C-087: "new device"
// findings). Nothing until the installation has a day of history, or every device of a fresh
// install would count as new.
export function firstSeenSince(since) {
  const first = db.prepare(`SELECT MIN(ts) t FROM client_samples`).get()?.t;
  if (!first || first > since - 24 * 3600e3) return [];
  return db.prepare(`SELECT mac, MIN(ts) ts, MAX(wired) wired FROM client_samples GROUP BY mac HAVING MIN(ts) >= ?`).all(since);
}

export function saveLocalNames(source, pairs, ts = Date.now()) {
  db.exec("BEGIN");
  try {
    db.prepare(`DELETE FROM local_names WHERE source = ?`).run(source);
    const ins = db.prepare(`INSERT INTO local_names (key, name, source, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(source, key) DO NOTHING`);
    for (const [key, name] of pairs) ins.run(key, name, source, ts);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function localNames() {
  // A UniFi device's own name wins over a client record for the same address.
  const out = new Map();
  for (const r of db.prepare(`SELECT key, name FROM local_names ORDER BY source = 'device' DESC`).all()) if (!out.has(r.key)) out.set(r.key, r.name);
  return out;
}

export function newestSiemTs(kind) {
  return db.prepare(`SELECT MAX(ts) AS ts FROM siem_events WHERE kind = ?`).get(kind)?.ts || null;
}

export function oldestSiemTs(kind) {
  return db.prepare(`SELECT MIN(ts) AS ts FROM siem_events WHERE kind = ?`).get(kind)?.ts || null;
}

// ---- live samples (UU-C-056) ---------------------------------------------------------

// The switch port of a wired client (UU-C-078); added in place to databases made before it.
if (!db.prepare(`PRAGMA table_info(client_samples)`).all().some((c) => c.name === "port")) {
  db.exec(`ALTER TABLE client_samples ADD COLUMN port INTEGER`);
}
if (!db.prepare(`PRAGMA table_info(client_samples)`).all().some((c) => c.name === "uptime")) {
  db.exec(`ALTER TABLE client_samples ADD COLUMN uptime INTEGER`);
}
const insClient = db.prepare(`INSERT OR REPLACE INTO client_samples
  (ts, mac, wired, ap_mac, radio, channel, width, essid, signal, noise, tx_rate, rx_rate, satisfaction, tx_retries, tx_attempts, port, uptime)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const insDevice = db.prepare(`INSERT OR REPLACE INTO device_samples
  (ts, mac, name, type, model, state, cpu, mem, temp, uptime, clients, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const insWan = db.prepare(`INSERT OR REPLACE INTO wan_samples
  (ts, status, isp, latency, availability, drops, rx_rate, tx_rate, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

export function saveLiveSamples({ clients = [], devices = [], wan = null }) {
  db.exec("BEGIN");
  try {
    for (const c of clients) {
      insClient.run(c.ts, c.mac, c.wired ? 1 : 0, c.apMac, c.radio, c.channel, c.width, c.essid, c.signal, c.noise, c.txRate, c.rxRate, c.satisfaction, c.txRetries, c.txAttempts, c.port ?? null, c.uptime ?? null);
    }
    for (const d of devices) {
      insDevice.run(d.ts, d.mac, d.name, d.type, d.model, d.state, d.cpu, d.mem, d.temp, d.uptime, d.clients, JSON.stringify(d.data || {}));
    }
    if (wan) insWan.run(wan.ts, wan.status, wan.isp, wan.latency, wan.availability, wan.drops, wan.rxRate, wan.txRate, JSON.stringify(wan.data || {}));
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function pruneLiveSamples(before) {
  for (const t of ["client_samples", "device_samples", "wan_samples"]) db.prepare(`DELETE FROM ${t} WHERE ts < ?`).run(before);
}

export function queryClientSamples(start, end, mac) {
  const sql = `SELECT * FROM client_samples WHERE ts >= ? AND ts < ?${mac ? " AND mac = ?" : ""} ORDER BY ts`;
  return mac ? db.prepare(sql).all(start, end, mac) : db.prepare(sql).all(start, end);
}

export function queryDeviceSamples(start, end) {
  return db.prepare(`SELECT * FROM device_samples WHERE ts >= ? AND ts < ? ORDER BY ts`).all(start, end).map((r) => ({ ...r, data: JSON.parse(r.data || "{}") }));
}

export function queryWanSamples(start, end) {
  return db.prepare(`SELECT * FROM wan_samples WHERE ts >= ? AND ts < ? ORDER BY ts`).all(start, end).map((r) => ({ ...r, data: JSON.parse(r.data || "{}") }));
}

export function latestDeviceSamples() {
  return db.prepare(`SELECT d.* FROM device_samples d JOIN (SELECT mac, MAX(ts) ts FROM device_samples GROUP BY mac) m ON d.mac = m.mac AND d.ts = m.ts`).all().map((r) => ({ ...r, data: JSON.parse(r.data || "{}") }));
}

export function latestWanSample() {
  const r = db.prepare(`SELECT * FROM wan_samples ORDER BY ts DESC LIMIT 1`).get();
  return r ? { ...r, data: JSON.parse(r.data || "{}") } : null;
}

export function firstClientSampleTs() {
  return db.prepare(`SELECT MIN(ts) AS ts FROM client_samples`).get()?.ts || null;
}

// ---- UniFi daily per-device totals (UU-C-057) ------------------------------------------

const upDaily = db.prepare(`INSERT OR REPLACE INTO daily_device (day, mac, rx, tx) VALUES (?, ?, ?, ?)`);

export function saveDailyDevice(rows) {
  db.exec("BEGIN");
  try {
    for (const r of rows) upDaily.run(r.day, r.mac, r.rx, r.tx);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function queryDailyDevice(firstDay, lastDay, mac) {
  const sql = `SELECT day, mac, rx, tx FROM daily_device WHERE day >= ? AND day <= ?${mac ? " AND mac = ?" : ""}`;
  return mac ? db.prepare(sql).all(firstDay, lastDay, mac) : db.prepare(sql).all(firstDay, lastDay);
}

export function pruneDailyDevice(beforeDay) {
  db.prepare(`DELETE FROM daily_device WHERE day < ?`).run(beforeDay);
}
