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

export function parseLine(line, now = Date.now()) {
  if (!line) return null;
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

function queue(line) {
  const ev = parseLine(line.replace(/\r$/, ""));
  state.received += 1;
  state.lastReceivedAt = Date.now();
  if (!ev) return;
  state.pending.push(ev);
  if (!state.flushTimer) {
    state.flushTimer = setTimeout(() => {
      state.flushTimer = null;
      const batch = state.pending.splice(0);
      try {
        save(batch);
      } catch (err) {
        logError("siem save", err);
      }
    }, 2000);
  }
}

function stopListener() {
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
