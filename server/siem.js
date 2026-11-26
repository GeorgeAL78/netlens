import crypto from "node:crypto";
import dgram from "node:dgram";
import net from "node:net";
import * as db from "./db.js";
import * as unifi from "./unifi.js";
import { logError } from "./log.js";

// UniFi's SIEM export (CyberSecure > Traffic Logging > Activity Logging > SIEM Server),
// optionally relayed by a syslog server such as syslog-ng, which forwards a copy to this app
// over TCP or UDP (UU-C-050). Network events themselves come from UniFi's System Log over
// the API (UU-C-051); this listener only adds ad-block hits.
//
// Two kinds of line carry anything this app uses (measured on the first real sample,
// 2026-10-05):
//   * CEF events — "CEF:0|Ubiquiti|UniFi Network|<ver>|<id>|<name>|<sev>|UNIFI...=..."
//     e.g. "Wired Client Disconnected" with the switch/AP, port, duration and the data
//     used during that connection. They carry their own UTC time (UNIFIutcTime).
//   * coredns JSON — {"type":"dnsAdBlock","category":"ADVERTISEMENT","domain":...,"mac":...}
//     Ad-block hits only, not every DNS lookup. They carry unix_milli_timestamp.
// Everything else (service chatter, DHCP, kernel) is skipped. Nothing here is traffic
// volume: usage still comes only from the UniFi API.

// Events are kept 90 days — the owner's choice (UU-C-052), matching the console's own
// System Log retention. Usage data stays at the cache's 30 days.
export const RETAIN_MS = 90 * 24 * 60 * 60 * 1000;
// Bumped when normalizeSystemLog keeps more; stored rows are then re-read and replaced once.
const SYSTEM_LOG_FORMAT = "2";
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

const state = {
  systemLog: { lastPulledAt: null, added: 0, error: null },
  port: null,
  tcp: null,
  udp: null,
  listening: false,
  lastReceivedAt: null,
  received: 0,
  error: null,
  pending: [],
  flushTimer: null,
  lastPrune: 0,
};

function uidOf(payload) {
  return crypto.createHash("sha1").update(payload).digest("hex");
}

// Syslog header time, used only when the payload carries no time of its own. RFC 3164
// headers have no year: assume this year, or last year if that would be in the future.
function headerTime(line, now) {
  const iso = /^(?:<\d+>)?(?:\d+ )?(\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:?\d\d))/.exec(line);
  if (iso) return Date.parse(iso[1]) || null;
  const m = /^(?:<\d+>)?(?:\d+ )?([A-Z][a-z]{2}) +(\d{1,2}) (\d\d):(\d\d):(\d\d)/.exec(line);
  if (!m || !(m[1] in MONTHS)) return null;
  const year = new Date(now).getFullYear();
  let t = new Date(year, MONTHS[m[1]], Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])).getTime();
  if (t > now + 24 * 60 * 60 * 1000) t = new Date(year - 1, MONTHS[m[1]], Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])).getTime();
  return t;
}

// "UNIFIa=b c UNIFId=e msg=f g." -> { a: "b c", d: "e", msg: "f g." }
function cefExtension(ext) {
  const out = {};
  const keys = [...ext.matchAll(/(?:^|\s)([A-Za-z][A-Za-z0-9_]*)=/g)];
  keys.forEach((k, i) => {
    const from = k.index + k[0].length;
    const to = i + 1 < keys.length ? keys[i + 1].index : ext.length;
    out[k[1].replace(/^UNIFI/, "")] = ext.slice(from, to).trim();
  });
  return out;
}

// ---- access point device logs (UU-C-299) ----------------------------------------------
// UniFi's "Access Points" device log (Activity Logging › SIEM Server › Devices), measured on
// U7 Pro / U7 Pro Wall, firmware 8.8.14. Three kinds of line carry what the API does not:
//   stahtd STA_ASSOC_TRACKER JSON — "sta_leave" (why a device left: sta_dc_reason, the 802.11
//     disassoc_reason code, avg_rssi before it went) and "dns timeout" (dns_timeouts count);
//     any other event_type except association / success (which repeat the System Log and
//     wifi-connectivity) is kept too, as it may be a problem the page can show later;
//   mcad log_sta_anomalies — per device: signal, satisfaction_now, anomalies (dns_timeout,
//     tcp_latency…), every ~20 s while it lasts (queue() keeps one per device and set per 5 min).
// The header's "<mac>,<model>-<version>:" tag names the access point.
export const AP_KIND = "ap";
const AP_TAG = /\s([0-9a-f]{12}),[^\s:]+:\s/i;
const colons = (hex) => hex.toLowerCase().match(/../g).join(":");
const macOf = (v) => (/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(String(v || "")) ? String(v).toLowerCase() : null);
function apLineTime(line, now) {
  const t = headerTime(line, now);
  // The lines arrive as they happen; a device clock in another zone must not move them.
  return t && Math.abs(t - now) < 15 * 60e3 ? t : now;
}
// 802.11v band steering (UU-C-304), the access point's kernel log: a request
//   "vap-2(wifi1ap7):BTM: STA <mac> RSSI: -77, candidates: 4, error: 0, flags: ALLOW (0x1)"
// and the device's answer
//   "BTM: Received response from [<mac>](len = 5): dialog_token 1, status 1, delay 0, bssid n/a, cancel 0".
// Status per IEEE 802.11 table 9-428: 0 accepted, 6 sent its own list, anything else refused.
const BTM_ASK = /BTM: STA ([0-9a-f:]{17}) RSSI: (-?\d+), candidates: (\d+)/i;
const BTM_REPLY = /BTM: Received response from \[([0-9a-f:]{17})\][^:]*: .*?status (\d+)[^,]*, delay \d+, bssid ([0-9a-f:]{17}|n\/a)/i;
const VAP = /\((wifi\d+ap\d+)\)/;

// A gateway problem worth knowing (UU-C-304): its message service failing to reach another part
// of the console, e.g. "unifi-mq-broker: Failed to send request to coredns: ... connect: connection refused".
const GW_FAIL = /unifi-mq-broker(?:\[\d+\])?: Failed to send request to (\w+)\b.*?(?:connect: |: )([^:"]+?)\s*$/i;
export function parseGatewayLine(line, now = Date.now()) {
  const m = GW_FAIL.exec(line);
  if (!m) return null;
  const host = syslogSource(line).host;
  const ts = apLineTime(line, now);
  const target = m[1].toLowerCase();
  const why = (m[2] || "failed").trim().toLowerCase();
  return { uid: uidOf(`${host}|${ts}|${line}`), ts, kind: GW_KIND, name: `Can't reach ${target}`, category: "console", mac: null, data: { host, target, why, n: 1, merge: `gw|${target}|${why}` } };
}
export const GW_KIND = "gw";

export function parseApLine(line, now = Date.now()) {
  const tracker = line.indexOf("STA_ASSOC_TRACKER");
  const anomaly = line.indexOf("log_sta_anomalies");
  const btm = line.indexOf("BTM: ");
  if (btm >= 0) {
    const ask = BTM_ASK.exec(line);
    const reply = ask ? null : BTM_REPLY.exec(line);
    if (!ask && !reply) return null;
    const host = syslogSource(line).host;
    const tag = AP_TAG.exec(line);
    const ts = apLineTime(line, now);
    const vap = VAP.exec(line)?.[1] || null;
    const base = { ap: host, apMac: tag ? colons(tag[1]) : null, vap, n: 1 };
    if (ask) {
      const mac = ask[1].toLowerCase();
      return { uid: uidOf(`${host}|${ts}|${line}`), ts, kind: AP_KIND, name: "Asked to move", category: "steer", mac, data: { ...base, rssi: Number(ask[2]), candidates: Number(ask[3]), merge: `${mac}|steer` } };
    }
    const mac = reply[1].toLowerCase();
    const status = Number(reply[2]);
    return { uid: uidOf(`${host}|${ts}|${line}`), ts, kind: AP_KIND, name: status === 0 ? "Moved when asked" : status === 6 ? "Suggested its own access points" : "Refused to move", category: "steer-reply", mac, data: { ...base, status, to: reply[3] === "n/a" ? null : reply[3].toLowerCase(), merge: `${mac}|reply|${status}` } };
  }
  if (tracker < 0 && anomaly < 0) return null;
  const host = syslogSource(line).host;
  const tag = AP_TAG.exec(line);
  const apMac = tag ? colons(tag[1]) : null;
  const ts = apLineTime(line, now);
  const base = { ap: host, apMac };
  if (tracker >= 0) {
    let o;
    try {
      o = JSON.parse(line.slice(line.lastIndexOf("{", tracker)));
    } catch {
      return null;
    }
    const type = String(o.event_type || "");
    const mac = macOf(o.mac);
    if (!mac || !type || type === "association" || type === "success") return null;
    const rest = Object.fromEntries(Object.entries(o).filter(([k]) => !["op", "message_type", "mac", "event_type"].includes(k)));
    if (type === "sta_leave")
      return { uid: uidOf(`${host}|${ts}|${line}`), ts, kind: AP_KIND, name: "Left Wi-Fi", category: "leave", mac, data: { ...base, reason: o.sta_dc_reason || null, code: o.disassoc_reason != null ? Number(o.disassoc_reason) : null, rssi: o.avg_rssi != null ? Number(o.avg_rssi) : null, vap: o.vap || null } };
    if (type === "dns timeout")
      return { uid: uidOf(`${host}|${ts}|${line}`), ts, kind: AP_KIND, name: "DNS timeouts", category: "dns", mac, data: { ...base, n: Number(o.dns_timeouts) || 1, vap: o.vap || null } };
    return { uid: uidOf(`${host}|${ts}|${line}`), ts, kind: AP_KIND, name: type, category: "other", mac, data: { ...base, ...rest } };
  }
  const kv = Object.fromEntries([...line.slice(anomaly).matchAll(/(\w+)=(\S+)/g)].map((m) => [m[1], m[2]]));
  const mac = macOf(kv.sta);
  if (!mac || !kv.anomalies) return null;
  return {
    uid: uidOf(`${host}|${ts}|${line}`),
    ts,
    kind: AP_KIND,
    name: "Wi-Fi anomaly",
    category: "anomaly",
    mac,
    data: { ...base, anomalies: kv.anomalies.split(",").filter(Boolean), signal: kv.signal != null ? Number(kv.signal) : null, satisfaction: kv.satisfaction_now != null ? Number(kv.satisfaction_now) : null, radio: kv.radio || null, vap: kv.vap || null },
  };
}

export function parseLine(line, now = Date.now()) {
  if (!line) return null;
  const ap = parseApLine(line, now) || parseGatewayLine(line, now);
  if (ap) return ap;
  const c = line.indexOf("CEF:");
  if (c >= 0) {
    const payload = line.slice(c);
    const parts = payload.split("|");
    if (parts.length < 8) return null;
    const ext = cefExtension(parts.slice(7).join("|"));
    const ts = Date.parse(ext.utcTime || "") || headerTime(line, now);
    if (!ts) return null;
    const mac = String(ext.clientMac || ext.srcMac || ext.mac || "").toLowerCase() || null;
    return {
      uid: uidOf(payload),
      ts,
      kind: "cef",
      name: parts[5] || null,
      category: ext.category || null,
      mac,
      data: { ...ext, severity: Number(parts[6]) || null, eventId: parts[4] || null },
    };
  }
  const j = line.indexOf('{"');
  if (j >= 0) {
    let o;
    try {
      o = JSON.parse(line.slice(j));
    } catch {
      return null;
    }
    if (!o || !o.type) return null;
    const ts = Number(o.unix_milli_timestamp) || Date.parse(o.timestamp || "") || headerTime(line, now);
    if (!ts) return null;
    return {
      uid: uidOf(line.slice(j)),
      ts,
      kind: "dns",
      name: o.type,
      category: o.category || null,
      mac: String(o.mac || "").toLowerCase() || null,
      data: { domain: o.domain || null, ip: o.ip || null },
    };
  }
  return null;
}

function save(events, { replace = false } = {}) {
  if (!events.length) return 0;
  const added = db.saveSiemEvents(events, { replace });
  const now = Date.now();
  if (now - state.lastPrune > 60 * 60 * 1000) {
    db.pruneSiemEvents(now - RETAIN_MS);
    state.lastPrune = now;
  }
  return added;
}

// ---- UniFi System Log (pulled) --------------------------------------------------------
//
// The primary source since UU-C-051: the Network app's own System Log over the API the app
// already uses — client connects/disconnects/roams with exact bytes, AP or switch port and
// signal; threats; admin changes; WAN alerts. The console keeps ~90 days, so a PC that was
// off for two weeks loses nothing. The syslog listener below only adds ad-block hits.

function render(template, params) {
  return String(template || "").replace(/\{([A-Z0-9_]+)\}/g, (_, k) => params?.[k]?.name ?? params?.[k]?.id ?? k);
}

function pretty(code) {
  const s = String(code || "").replace(/_\d+$/, "").toLowerCase().replace(/_/g, " ");
  return s ? s[0].toUpperCase() + s.slice(1) : null;
}

export function normalizeSystemLog(e) {
  const p = e?.parameters || {};
  const ts = Number(e?.timestamp);
  if (!ts) return null;
  const via =
    p.DEVICE_WITH_PORT?.name ||
    (p.DEVICE_FROM && p.DEVICE_TO ? `${p.DEVICE_FROM.name} → ${p.DEVICE_TO.name}` : null) ||
    p.DEVICE?.name ||
    null;
  return {
    uid: `api:${e.id || uidOf(JSON.stringify(e))}`,
    ts,
    kind: "log",
    name: render(e.title_raw, p).trim() || pretty(e.key) || "Event",
    category: pretty(e.category),
    mac: String(p.CLIENT?.id || "").toLowerCase() || null,
    data: {
      key: e.key || null,
      severity: e.severity ?? null,
      clientAlias: p.CLIENT?.name || p.CLIENT?.hostname || null,
      clientIp: p.CLIENT?.ip || p.IP?.name || null,
      via,
      duration: p.DURATION?.name || null,
      usageDown: p.DATA_DOWN?.name || null,
      usageUp: p.DATA_UP?.name || null,
      bytesDown: Number(p.DATA_DOWN?.id) || null,
      bytesUp: Number(p.DATA_UP?.id) || null,
      signal: p.SIGNAL_STRENGTH?.name || null,
      msg: render(e.message_raw, p).trim() || null,
      // Every parameter as {name, id}: threat events carry SRC_CLIENT/SRC_IP, DST_IP/
      // DST_CLIENT and TRIGGER (the firewall policy), which the Threats view groups by.
      params: Object.fromEntries(
        Object.entries(p).map(([k, v]) => [k, { n: v?.name ?? null, i: v?.id ?? null }])
      ),
    },
  };
}

export async function refreshSystemLog() {
  const now = Date.now();
  const newest = db.newestSiemTs("log");
  // Re-read the last 10 minutes; the uid makes overlap free. First run: the full 90 days.
  const from = Math.max(now - RETAIN_MS, newest ? newest - 10 * 60 * 1000 : 0);
  try {
    const rows = await unifi.getSystemLog({ startMs: from, endMs: now });
    // One-time catch-up when retention grew (30 -> 90 days): an app that already pulled
    // 30 days would otherwise only ever read forward. Recorded so it runs once — the
    // console may hold less than 90 days, and asking again would find nothing new.
    // Also when the stored format changed: UU-C-056 started keeping every parameter, so
    // older rows are re-read once and replaced.
    const formatStale = db.metaGet("system_log_format") !== SYSTEM_LOG_FORMAT;
    if (newest && (formatStale || db.metaGet("system_log_retention") !== String(RETAIN_MS))) {
      const oldest = formatStale ? from : db.oldestSiemTs("log") || now;
      for (const e of await unifi.getSystemLog({ startMs: now - RETAIN_MS, endMs: oldest })) rows.push(e);
    }
    db.metaSet("system_log_retention", RETAIN_MS);
    const added = save(rows.map(normalizeSystemLog).filter(Boolean), { replace: formatStale });
    db.metaSet("system_log_format", SYSTEM_LOG_FORMAT);
    state.systemLog = { lastPulledAt: now, added, error: null };
    return { pulled: rows.length, added };
  } catch (err) {
    state.systemLog = { ...state.systemLog, error: err.message };
    throw err;
  }
}

// ---- listen source ------------------------------------------------------------------

// Lines NetLens does not use yet (UU-C-295): the device logs UniFi can add to its SIEM export
// (Gateway, Access Points, Switches: kernel, hostapd, port links...). Kept in memory only, never
// written: the newest 25 per program and a count of each, so a chatty program cannot push the
// rare ones out. GET /api/siem/unparsed shows them, to decide what is worth reading properly.
const UNPARSED_PER_PROG = 25;
const unparsed = { since: Date.now(), total: 0, progs: new Map(), hosts: new Map() };
const anomalySeen = new Map();
const merged = new Map(); // merge key -> the row being counted (UU-C-304)
// UniFi puts a tag between the host and the program (measured on Network 11 / firmware 8.8):
// access points "<mac>,<model>-<version>:", the gateway its own name again, so the program is
// the first "name[pid]:" or "name:" among the next three words.
const HEADER = /^\s*(?:\d+\s+)?(?:<\d+>)?(?:\d\s+)?(?:[A-Z][a-z]{2}\s+\d+\s+[\d:]+|\d{4}-\d\d-\d\dT\S+)\s+(\S+)\s+(.*)$/;
export function syslogSource(line) {
  const m = HEADER.exec(line);
  if (!m) return { host: "?", prog: "?" };
  const words = m[2].split(/\s+/).slice(0, 3);
  for (const w of words) {
    const p = /^([A-Za-z][\w.-]*)(?:\[\d+\])?:$/.exec(w);
    if (p) return { host: m[1], prog: p[1] };
  }
  return { host: m[1], prog: words[0]?.replace(/[:[].*$/, "") || "?" };
}
function keepUnparsed(line) {
  const { host, prog } = syslogSource(line);
  unparsed.total += 1;
  unparsed.hosts.set(host, (unparsed.hosts.get(host) || 0) + 1);
  const p = unparsed.progs.get(prog) || { n: 0, lines: [] };
  p.n += 1;
  p.lines.push({ at: Date.now(), host, line: line.slice(0, 1500) });
  if (p.lines.length > UNPARSED_PER_PROG) p.lines.shift();
  unparsed.progs.set(prog, p);
}
export function unparsedLines({ prog = null, q = null } = {}) {
  const needle = q ? String(q).toLowerCase() : null;
  const lines = [];
  for (const [name, p] of unparsed.progs) {
    if (prog && name !== prog) continue;
    for (const l of p.lines) if (!needle || l.line.toLowerCase().includes(needle)) lines.push({ prog: name, ...l });
  }
  return {
    since: unparsed.since,
    total: unparsed.total,
    programs: [...unparsed.progs].map(([name, p]) => ({ name, count: p.n })).sort((a, b) => b.count - a.count),
    hosts: [...unparsed.hosts].map(([name, n]) => ({ name, count: n })).sort((a, b) => b.count - a.count),
    lines: lines.sort((a, b) => b.at - a.at),
  };
}

function queue(line) {
  const clean = line.replace(/\r$/, "");
  const ev = parseLine(clean);
  state.received += 1;
  state.lastReceivedAt = Date.now();
  if (!ev) {
    if (clean.trim()) keepUnparsed(clean);
    return;
  }
  // An anomaly repeats every ~20 s while it lasts: one per device and set of anomalies per 5 min.
  if (ev.kind === AP_KIND && ev.category === "anomaly") {
    const key = `${ev.mac}|${ev.data.anomalies.join(",")}`;
    if (ev.ts - (anomalySeen.get(key) || 0) < 5 * 60e3) return;
    anomalySeen.set(key, ev.ts);
    if (anomalySeen.size > 5000) anomalySeen.clear();
  }
  // Band steering and gateway failures repeat every few seconds while they last (UU-C-304): one
  // row per device (or failure) per 10 minutes, its count `n` raised and the last signal kept.
  if (ev.data?.merge) {
    const key = ev.data.merge;
    const open = merged.get(key);
    if (open && ev.ts - open.ts < 10 * 60e3) {
      open.data.n += 1;
      open.data.last = ev.ts;
      if (ev.data.rssi != null) open.data.rssi = ev.data.rssi;
      state.pending.push({ ...open, data: { ...open.data }, replace: true });
      scheduleFlush();
      return;
    }
    merged.set(key, ev);
    if (merged.size > 5000) merged.clear();
  }
  state.pending.push(ev);
  scheduleFlush();
}

// Saved every 2 s: new rows first, then the merged rows whose count went up (written over).
function scheduleFlush() {
  if (state.flushTimer) return;
  state.flushTimer = setTimeout(() => {
    state.flushTimer = null;
    const batch = state.pending.splice(0);
    try {
      save(batch.filter((e) => !e.replace));
      const again = batch.filter((e) => e.replace).map(({ replace, ...e }) => e);
      if (again.length) save(again, { replace: true });
    } catch (err) {
      logError("siem save", err);
    }
  }, 2000);
}

export function stopListener() {
  for (const s of [state.tcp, state.udp]) {
    try {
      s?.close();
    } catch {
      /* already closed */
    }
  }
  state.tcp = null;
  state.udp = null;
  state.listening = false;
  state.port = null;
}

function startListener(port) {
  stopListener();
  state.port = port;
  state.error = null;
  // TCP: syslog-ng's network() destination sends newline-terminated lines. Octet-counted
  // framing ("123 <14>...") is tolerated because the parser finds CEF/JSON anywhere.
  state.tcp = net.createServer((sock) => {
    let rest = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk) => {
      const text = rest + chunk;
      const parts = text.split("\n");
      rest = parts.pop();
      for (const line of parts) queue(line);
    });
    sock.on("end", () => rest && queue(rest));
    sock.on("error", () => {});
  });
  state.tcp.on("error", (err) => {
    state.error = `cannot listen on TCP ${port}: ${err.code || err.message}`;
    state.listening = false;
  });
  state.tcp.listen(port, "0.0.0.0", () => {
    state.listening = true;
  });
  // UDP too, so UniFi can also be pointed straight at this PC while it is on.
  state.udp = dgram.createSocket("udp4");
  state.udp.on("message", (msg) => {
    for (const line of msg.toString("utf8").split("\n")) if (line) queue(line);
  });
  state.udp.on("error", () => {});
  state.udp.bind(port, "0.0.0.0");
}

// Apply the current settings: start, restart or stop the listener.
export function configure() {
  const port = Number(db.getSetting("siem_port", "")) || null;
  if (port && port !== state.port) startListener(port);
  if (!port && state.port) stopListener();
}

export function status() {
  const stats = db.siemStats();
  return {
    systemLog: state.systemLog,
    port: Number(db.getSetting("siem_port", "")) || null,
    listening: state.listening,
    lastReceivedAt: state.lastReceivedAt,
    received: state.received,
    error: state.error,
    events: stats?.events || 0,
    newest: stats?.newest || null,
    oldest: stats?.oldest || null,
  };
}
