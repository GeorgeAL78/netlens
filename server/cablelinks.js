// Wired links going down and up, from the switches' own log (UU-C-311): siem_events kind 'sw',
// written by siem.js. A "drop" is one link-down and what followed within a minute — a PC waking
// up takes the link down and up twice in ten seconds, which is one drop, not two. The speed it
// came back at says what happened: 10 Mbps is a sleeping or switched-off device keeping its
// network card awake (Wake-on-LAN), below its usual speed is standby or a weak cable, its usual
// speed is a restart, a wake-up, a replug or a loose cable.
import * as db from "./db.js";
import * as insights from "./insights.js";
import { guestKind } from "./guests.js";

const SAME_DROP_MS = 60e3;
const DAY = 86400e3;

// Drops in one port's rows (oldest first), oldest first.
export function drops(rows, usual = null) {
  const out = [];
  let cur = null;
  for (const r of rows) {
    if (!r.up) {
      if (cur && r.ts - (cur.back ?? cur.ts) < SAME_DROP_MS) {
        cur.downs += 1;
        cur.back = null;
      } else {
        cur = { ts: r.ts, downs: 1, back: null, speed: null };
        out.push(cur);
      }
    } else if (cur && (cur.back == null || r.ts - cur.back < SAME_DROP_MS)) {
      cur.back = r.ts;
      if (r.speed != null) cur.speed = r.speed;
    }
  }
  const top = usual ?? Math.max(0, ...rows.map((r) => r.speed || 0));
  let prev = null;
  for (const d of out) {
    d.what = d.back == null ? "down" : d.speed != null && d.speed <= 10 ? "asleep" : d.speed != null && top && d.speed < top ? "slower" : prev?.what === "asleep" ? "woke" : "back";
    d.text = dropText(d, top, prev);
    prev = d;
  }
  return out;
}

const mbps = (n) => (n >= 1000 ? `${n / 1000} Gbps` : `${n} Mbps`);
function dropText(d, top, prev) {
  if (d.what === "down") return "went down and has not come back";
  const after = Math.max(1, Math.round((d.back - d.ts) / 1000));
  const twice = d.downs > 1 ? `, after going down ${d.downs} times in a row` : "";
  if (d.what === "asleep") return `back at ${mbps(d.speed)} after ${after} s: the device went to sleep or was switched off (its network card stays on at low speed)`;
  if (d.what === "slower") return `back at ${mbps(d.speed)} instead of its usual ${mbps(top)}: standby, or a cable or port that can't carry more`;
  if (d.what === "woke") return `back at ${d.speed ? mbps(d.speed) : "full speed"}${twice}: it woke up (asleep ${durationText(d.ts - prev.ts)})`;
  return `back at ${d.speed ? mbps(d.speed) : "full speed"} after ${after} s${twice}: a restart, a replug or a loose cable`;
}
function durationText(ms) {
  const m = Math.round(ms / 60e3);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ""}`.trim();
}

// The fastest speed each port came up at over 30 days: what "usual" means.
function usualSpeed(swMac, port, end) {
  return Math.max(0, ...db.switchLinks(end - 30 * DAY, end, swMac, port).map((r) => r.speed || 0)) || null;
}

// One wired device's drops in [start, end): on each switch port it used in the week before, each
// drop counted only when that port was where the device was at the time — the last place it was
// seen before the drop (a sleeping PC sends no samples), else the first one after.
export function forDevice(mac, start, end) {
  const nameOf = insights.names();
  const places = insights.placeStretches(db.wiredPlacesOf(String(mac).toLowerCase(), start - 7 * DAY, end));
  const placeAt = (ts) => {
    let at = places[0] || null;
    for (const p of places) if (p.from <= ts) at = p;
    return at ? `${at.apMac}|${at.port}` : null;
  };
  const seen = new Map();
  for (const p of places) seen.set(`${p.apMac}|${p.port}`, p);
  const ports = [];
  for (const [k, p] of seen) {
    const usual = usualSpeed(p.apMac, p.port, end);
    const list = drops(db.switchLinks(start - DAY, end, p.apMac, p.port), usual).filter((d) => d.ts >= start && placeAt(d.ts) === k);
    ports.push({ swMac: p.apMac, via: nameOf(p.apMac), port: Number(p.port), usual, drops: list.reverse() });
  }
  const anyLog = db.switchLinks(end - 30 * DAY, end).length > 0;
  return { ports, total: ports.reduce((a, p) => a + p.drops.length, 0), switchLog: anyLog };
}

// Per switch port in [start, end), for Overview: drops that sleep, wake-up or standby don't explain.
export function summary(start, end) {
  const nameOf = insights.names();
  const byPort = new Map();
  for (const r of db.switchLinks(start - DAY, end)) {
    const k = `${r.swMac}|${r.port}`;
    if (!byPort.has(k)) byPort.set(k, []);
    byPort.get(k).push(r);
  }
  if (!byPort.size) return [];
  // Who was on the port at its last drop: the physical device among the wired ones seen there
  // last (a server's containers share its port).
  const vendor = new Map(db.listStoredClients().map((c) => [String(c.mac).toLowerCase(), c.vendor || null]));
  const onPort = (swMac, port, at) => {
    const seen = db.wiredOnPortAt(swMac, port, at);
    if (!seen.length) return null;
    const recent = seen.filter((r) => r.ts >= seen[0].ts - 3600e3);
    return recent.find((r) => !guestKind(r.mac, vendor.get(r.mac), true)) || recent[0];
  };
  const out = [];
  for (const [k, rows] of byPort) {
    const [swMac, port] = k.split("|");
    const list = drops(rows, usualSpeed(swMac, port, end)).filter((d) => d.ts >= start);
    if (!list.length) continue;
    const dev = onPort(swMac, port, list[list.length - 1].ts);
    out.push({
      swMac,
      via: nameOf(swMac) || rows[0].host,
      port: Number(port),
      mac: dev?.mac || null,
      name: dev ? nameOf(dev.mac) : null,
      drops: list.length,
      unexplained: list.filter((d) => d.what === "back" || d.what === "down").length,
      asleep: list.filter((d) => d.what === "asleep").length,
      last: list[list.length - 1].ts,
    });
  }
  return out.sort((a, b) => b.unexplained - a.unexplained);
}
