import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { databaseDir } from "./paths.js";

// Connection records (flows) live here, not in the day JSON files (UU-C-062). They were
// ~90% of each 35-40 MB day file and all of them sat in memory; a report now reads only
// what it needs. Own file, so it can grow, be vacuumed or be deleted without touching
// settings and history in unifi-usage.db.
//
// A day is always written whole (replace), in the order the cache built it: `seq` is the
// row's index in that day. Reads return rows in (day, seq) order, so every tie-break the
// report had over the in-memory arrays is kept exactly.
const db = new DatabaseSync(path.join(databaseDir, "flows.db"));
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS flows (
    day TEXT NOT NULL,
    seq INTEGER NOT NULL,
    t INTEGER NOT NULL,
    t_end INTEGER,
    mac TEXT NOT NULL,
    app TEXT,
    category TEXT,
    domain TEXT,
    bytes INTEGER,
    rx INTEGER,
    tx INTEGER,
    service TEXT,
    action TEXT,
    kind TEXT,
    confidence TEXT,
    source TEXT,
    ip TEXT,
    id TEXT,
    PRIMARY KEY (day, seq)
  ) WITHOUT ROWID;
  -- Covers the per-session destination lookup, so it never touches the table itself.
  CREATE INDEX IF NOT EXISTS flows_dest ON flows (mac, t, day, seq, domain, bytes);
  CREATE INDEX IF NOT EXISTS flows_t ON flows (t);
  CREATE INDEX IF NOT EXISTS flows_app ON flows (app, day);
  -- Per day x app x category x device bytes, rebuilt with the day. "Local network" rows
  -- keep their destination, because the report names those from the client list.
  -- first_seq is where the group first appears, for first-seen ordering.
  CREATE TABLE IF NOT EXISTS flow_groups (
    day TEXT NOT NULL,
    app TEXT,
    category TEXT,
    mac TEXT,
    ldomain TEXT,
    bytes INTEGER NOT NULL,
    first_seq INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS flow_groups_day ON flow_groups (day, mac);
  -- Per day x destination x device, for the Sites page (UU-C-136): 30 days x all devices read
  -- ~10x fewer rows than the flows themselves. flow_site_days marks the days built.
  CREATE TABLE IF NOT EXISTS flow_sites (
    day TEXT NOT NULL,
    domain TEXT,
    app TEXT,
    category TEXT,
    mac TEXT,
    ip TEXT,
    n INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    first INTEGER,
    last INTEGER
  );
  CREATE INDEX IF NOT EXISTS flow_sites_day ON flow_sites (day, mac);
  CREATE TABLE IF NOT EXISTS flow_site_days (day TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS flow_days (
    day TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    classifier INTEGER NOT NULL
  );
`);

// The rule that blocked a connection (UU-C-148): "Block YouTube on Kids Wi-Fi", "Ad Blocking"…
// Added to an existing flows.db in place; rows stored before have none.
if (!db.prepare(`PRAGMA table_info(flows)`).all().some((c) => c.name === "policy")) db.exec(`ALTER TABLE flows ADD COLUMN policy TEXT`);
db.exec(`CREATE INDEX IF NOT EXISTS flows_blocked ON flows (day, t) WHERE action = 'blocked'`);
// An early build named connection-tracking blocks "CONNTRACK"; they are UniFi's invalid-traffic rule.
db.exec(`UPDATE flows SET policy = 'Block Invalid Traffic' WHERE action = 'blocked' AND policy = 'CONNTRACK'`);

const COLS = ["t", "tEnd", "mac", "app", "category", "domain", "bytes", "bytesRx", "bytesTx", "service", "action", "kind", "confidence", "source", "ip", "id", "policy"];
const insertFlow = db.prepare(
  `INSERT INTO flows (day, seq, t, t_end, mac, app, category, domain, bytes, rx, tx, service, action, kind, confidence, source, ip, id, policy)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const deleteDayFlows = db.prepare(`DELETE FROM flows WHERE day = ?`);
const deleteDayGroups = db.prepare(`DELETE FROM flow_groups WHERE day = ?`);
const deleteDayMeta = db.prepare(`DELETE FROM flow_days WHERE day = ?`);
const deleteDaySites = db.prepare(`DELETE FROM flow_sites WHERE day = ?`);
const deleteDaySiteMark = db.prepare(`DELETE FROM flow_site_days WHERE day = ?`);
const buildSites = db.prepare(`
  INSERT INTO flow_sites (day, domain, app, category, mac, ip, n, bytes, first, last)
  SELECT day, domain, app, category, mac, MAX(ip), COUNT(*), COALESCE(SUM(bytes), 0),
         MIN(CASE WHEN t > 0 THEN t END), MAX(t)
  FROM flows WHERE day = ? GROUP BY domain, app, category, mac`);
const markSites = db.prepare(`INSERT OR REPLACE INTO flow_site_days (day) VALUES (?)`);
const siteDaysBuilt = () => new Set(db.prepare(`SELECT day FROM flow_site_days`).all().map((r) => r.day));

function rebuildSites(day) {
  deleteDaySites.run(day);
  buildSites.run(day);
  markSites.run(day);
}
const buildGroups = db.prepare(`
  INSERT INTO flow_groups (day, app, category, mac, ldomain, bytes, first_seq)
  SELECT day, app, category, mac, CASE WHEN app = 'Local network' THEN domain END AS ld,
         COALESCE(SUM(bytes), 0), MIN(seq)
  FROM flows WHERE day = ? GROUP BY app, category, mac, ld`);
const upsertDay = db.prepare(
  `INSERT INTO flow_days (day, count, classifier) VALUES (?, ?, ?)
   ON CONFLICT(day) DO UPDATE SET count = excluded.count, classifier = excluded.classifier`
);
const selectDay = db.prepare(
  `SELECT t, t_end, mac, app, category, domain, bytes, rx, tx, service, action, kind, confidence, source, ip, id, policy
   FROM flows WHERE day = ? ORDER BY seq`
);

const v = (x) => (x === undefined ? null : x);

// Back to the row shape the cache always used. Absent fields stay absent (not null), so a
// report serialises exactly as before.
function toRow(r) {
  const row = {
    app: r.app,
    category: r.category,
    domain: r.domain,
    confidence: r.confidence,
    t: r.t,
    tEnd: r.t_end,
    bytes: r.bytes,
    bytesRx: r.rx,
    bytesTx: r.tx,
    service: r.service,
    action: r.action,
    mac: r.mac,
  };
  if (r.source != null) row.source = r.source;
  if (r.kind != null) row.kind = r.kind;
  if (r.ip != null) row.ip = r.ip;
  if (r.id != null) row.id = r.id;
  if (r.policy != null) row.policy = r.policy;
  for (const k of Object.keys(row)) if (row[k] === null) delete row[k];
  return row;
}

export function dayInfo() {
  return new Map(db.prepare(`SELECT day, count, classifier FROM flow_days`).all().map((r) => [r.day, r]));
}

export function readDay(day) {
  return selectDay.all(day).map(toRow);
}

// The same rows in chunks, for an export that must not hold a whole day at once.
export function* iterDay(day, chunk = 5000) {
  let rows = [];
  for (const r of selectDay.iterate(day)) {
    rows.push(toRow(r));
    if (rows.length >= chunk) {
      yield rows;
      rows = [];
    }
  }
  if (rows.length) yield rows;
}

export function writeDay(day, rows, classifier) {
  db.exec("BEGIN");
  try {
    deleteDayFlows.run(day);
    deleteDayGroups.run(day);
    let seq = 0;
    for (const f of rows || []) {
      insertFlow.run(day, seq++, ...COLS.map((c) => v(f[c])));
    }
    buildGroups.run(day);
    rebuildSites(day);
    upsertDay.run(day, seq, classifier);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function deleteDay(day) {
  db.exec("BEGIN");
  try {
    deleteDayFlows.run(day);
    deleteDayGroups.run(day);
    deleteDayMeta.run(day);
    deleteDaySites.run(day);
    deleteDaySiteMark.run(day);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

const inList = (days) => days.map(() => "?").join(",") || "NULL";

// Groups for these days, in first-seen order across them (days ascending, then seq).
export function groups(days, mac) {
  if (!days.length) return [];
  const sql = `SELECT day, app, category, mac, ldomain, bytes, first_seq AS firstSeq FROM flow_groups
    WHERE day IN (${inList(days)})${mac ? " AND mac = ?" : ""} ORDER BY day, first_seq`;
  return db.prepare(sql).all(...days, ...(mac ? [mac] : []));
}

// The same groups, computed from the flows themselves for a stretch inside the days (a
// clicked hour, UU-C-075): flow_groups only holds whole days.
export function groupsInRange(days, mac, from, to) {
  if (!days.length) return [];
  const sql = `SELECT day, app, category, mac, CASE WHEN app = 'Local network' THEN domain END AS ldomain,
      COALESCE(SUM(bytes), 0) AS bytes, MIN(seq) AS firstSeq
    FROM flows WHERE day IN (${inList(days)}) AND t >= ? AND t < ?${mac ? " AND mac = ?" : ""}
    GROUP BY day, app, category, mac, ldomain ORDER BY day, firstSeq`;
  return db.prepare(sql).all(...days, from, to, ...(mac ? [mac] : []));
}

// `span` ({ from, to }) limits rows to a stretch inside the days; omitted = whole days.
const spanSql = (span, args) => {
  if (!span) return "";
  args.push(span.from, span.to);
  return " AND t >= ? AND t < ?";
};

// Rows of these days matching a filter, in the cache's own order (day, seq).
//   apps: exact app names; localDomains: "Local network" rows by destination.
export function rowsForApps(days, mac, apps, localDomains, span) {
  if (!days.length || (!apps.length && !localDomains.length)) return [];
  const conds = [];
  const args = [...days];
  const spanWhere = spanSql(span, args);
  if (mac) args.push(mac);
  if (apps.length) {
    conds.push(`app IN (${inList(apps)})`);
    args.push(...apps);
  }
  if (localDomains.length) {
    conds.push(`(app = 'Local network' AND domain IN (${inList(localDomains)}))`);
    args.push(...localDomains);
  }
  const sql = `SELECT t, t_end, mac, app, category, domain, bytes, rx, tx, service, action, kind, confidence, source, ip, id, policy
    FROM flows WHERE day IN (${inList(days)})${spanWhere}${mac ? " AND mac = ?" : ""} AND (${conds.join(" OR ")}) ORDER BY day, seq`;
  return db.prepare(sql).all(...args).map(toRow);
}

// The newest `limit` rows (t > 0), newest first; equal times keep the cache's order.
export function latest(days, mac, filter, limit, span) {
  if (!days.length) return [];
  const args = [...days];
  let where = `day IN (${inList(days)}) AND t > 0`;
  where += spanSql(span, args);
  if (mac) {
    where += " AND mac = ?";
    args.push(mac);
  }
  if (filter) {
    const conds = [];
    if (filter.apps.length) {
      conds.push(`app IN (${inList(filter.apps)})`);
      args.push(...filter.apps);
    }
    if (filter.localDomains.length) {
      conds.push(`(app = 'Local network' AND domain IN (${inList(filter.localDomains)}))`);
      args.push(...filter.localDomains);
    }
    if (!conds.length) return [];
    where += ` AND (${conds.join(" OR ")})`;
  }
  const sql = `SELECT t, t_end, mac, app, category, domain, bytes, rx, tx, service, action, kind, confidence, source, ip, id, policy
    FROM flows WHERE ${where} ORDER BY t DESC, day, seq LIMIT ?`;
  return db.prepare(sql).all(...args, limit).map(toRow);
}

// What one device talked to in [from, to]: the top `limit` destinations by bytes, and
// whether there was any. Equal byte counts rank by first appearance in time order (then
// the cache's order) — the order the report's in-memory version produced.
const destStmt = new Map();
export function destinations(days, mac, from, to, limit = 3) {
  if (!days.length) return { domains: [], any: false };
  const key = days.length;
  let stmt = destStmt.get(key);
  if (!stmt) {
    stmt = db.prepare(
      `SELECT domain, SUM(bytes) AS b, MIN(printf('%015d|%s|%09d', t, day, seq)) AS first
       FROM flows INDEXED BY flows_dest
       WHERE mac = ? AND t >= ? AND t <= ? AND t > 0 AND day IN (${inList(days)})
       GROUP BY domain ORDER BY b DESC, first LIMIT ?`
    );
    destStmt.set(key, stmt);
  }
  const rows = stmt.all(mac, from, to, ...days, limit);
  return { domains: rows.map((r) => (r.domain == null ? undefined : r.domain)), any: rows.length > 0 };
}

// Every destination of these days, one row per (domain, app, category, device) with its
// connections, bytes, first and last time — the Sites page (UU-C-135). `ip` is one address
// seen for it (rows named from another flow keep the address in `ip`).
export function siteSummary(days, mac, span) {
  if (!days.length) return [];
  if (!span) return siteSummaryDays(days, mac);
  const args = [...days];
  let where = `day IN (${inList(days)})`;
  where += spanSql(span, args);
  if (mac) {
    where += " AND mac = ?";
    args.push(mac);
  }
  const sql = `SELECT domain, app, category, MAX(ip) AS ip, mac, COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes,
      MIN(CASE WHEN t > 0 THEN t END) AS first, MAX(t) AS last
    FROM flows WHERE ${where} GROUP BY domain, app, category, mac`;
  return db.prepare(sql).all(...args);
}

// Whole days come from flow_sites; days written before it existed are built on first use.
function ensureSites(days) {
  const built = siteDaysBuilt();
  const missing = days.filter((d) => !built.has(d));
  if (!missing.length) return;
  db.exec("BEGIN");
  try {
    for (const d of missing) rebuildSites(d);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function siteSummaryDays(days, mac) {
  ensureSites(days);
  const sql = `SELECT domain, app, category, mac, MAX(ip) AS ip, SUM(n) AS n, SUM(bytes) AS bytes, MIN(first) AS first, MAX(last) AS last
    FROM flow_sites WHERE day IN (${inList(days)})${mac ? " AND mac = ?" : ""} GROUP BY domain, app, category, mac`;
  return db.prepare(sql).all(...days, ...(mac ? [mac] : []));
}

// Devices with connections in these days, for the Sites device picker.
export function siteDevices(days, span) {
  if (!days.length) return [];
  if (!span) {
    ensureSites(days);
    return db.prepare(`SELECT mac, SUM(n) AS n FROM flow_sites WHERE day IN (${inList(days)}) GROUP BY mac ORDER BY n DESC`).all(...days);
  }
  const args = [...days];
  const where = `day IN (${inList(days)})${spanSql(span, args)}`;
  return db.prepare(`SELECT mac, COUNT(*) AS n FROM flows WHERE ${where} GROUP BY mac ORDER BY n DESC`).all(...args);
}

// The newest connections to these raw destinations, newest first.
export function siteHits(days, mac, domains, limit = 50, span) {
  if (!days.length || !domains.length) return [];
  const args = [...days];
  let where = `day IN (${inList(days)}) AND t > 0`;
  where += spanSql(span, args);
  if (mac) {
    where += " AND mac = ?";
    args.push(mac);
  }
  where += ` AND domain IN (${inList(domains)})`;
  args.push(...domains);
  return db
    .prepare(`SELECT t, t_end, mac, app, category, domain, bytes, rx, tx, service, action, kind, confidence, source, ip, id, policy FROM flows WHERE ${where} ORDER BY t DESC, day, seq LIMIT ?`)
    .all(...args, limit)
    .map(toRow);
}

// Shutdown (UU-C-142): fold the WAL into the database file and close it.
export function close() {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    /* closing anyway */
  }
  db.close();
}

// Blocked rows still without a rule (UU-C-152), and naming one by its primary key.
export function blockedWithoutRule(days, since) {
  if (!days.length) return [];
  return db
    .prepare(`SELECT day, seq, id, t, mac FROM flows INDEXED BY flows_blocked WHERE action = 'blocked' AND day IN (${inList(days)}) AND t >= ? AND policy IS NULL`)
    .all(...days, since);
}

const setPolicyStmt = db.prepare(`UPDATE flows SET policy = ? WHERE day = ? AND seq = ?`);
export function setPolicies(rows) {
  db.exec("BEGIN");
  try {
    for (const r of rows) setPolicyStmt.run(r.policy, r.day, r.seq);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// One device's blocked connections in [from, to), newest first (UU-C-153), for the detail panel.
export function blockedRows(days, from, to, mac, limit = 500) {
  if (!days.length) return [];
  return db
    .prepare(
      `SELECT t, t_end, domain, ip, service, policy, bytes FROM flows INDEXED BY flows_blocked
       WHERE action = 'blocked' AND day IN (${inList(days)}) AND t >= ? AND t < ? AND mac = ? ORDER BY t DESC LIMIT ?`
    )
    .all(...days, from, to, mac, limit);
}

// Every blocked connection in [from, to), per device in time order (UU-C-156), for incidents.
export function blockedAll(days, from, to) {
  if (!days.length) return [];
  return db
    .prepare(
      `SELECT t, mac, domain, ip, service, policy FROM flows INDEXED BY flows_blocked
       WHERE action = 'blocked' AND day IN (${inList(days)}) AND t >= ? AND t < ? ORDER BY mac, t`
    )
    .all(...days, from, to);
}
