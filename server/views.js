import * as db from "./db.js";
import * as insights from "./insights.js";
import { sessionize } from "./classify.js";

// Read-only views for the redesigned interface (UU-C-087): the day grid, the network map and
// the findings feed. Like /api/report they read SQLite and the cache only — never UniFi.

const HOUR = 3600000;
const isMac = (v) => /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(String(v || "").toLowerCase());
const lower = (v) => String(v || "").toLowerCase();

// Latest client sample per MAC within [start, end).
function latestSamples(start, end) {
  const last = new Map();
  for (const r of db.queryClientSamples(start, end, null)) last.set(r.mac, r);
  return last;
}

function linkOf(r, nameOf) {
  if (!r) return null;
  return r.wired
    ? { wired: true, via: r.ap_mac ? nameOf(r.ap_mac) : null, port: r.port ?? null, speed: r.tx_rate != null ? Math.round(r.tx_rate / 1000) : null, uptime: r.uptime ?? null, ts: r.ts }
    : { wired: false, via: r.ap_mac ? nameOf(r.ap_mac) : null, signal: r.signal ?? null, radio: r.radio || null, essid: r.essid || null, uptime: r.uptime ?? null, ts: r.ts };
}

function healthOf(link, now, today) {
  if (!link) return "off";
  if (today && now - link.ts > 15 * 60 * 1000) return "off";
  if (link.wired) return link.speed != null && link.speed <= 100 ? "warn" : "ok";
  return link.signal != null && link.signal < -80 ? "warn" : "ok";
}

// Event markers per device and hour: roams/connects and blocked traffic.
function markersFor(start, end) {
  const marks = new Map();
  const add = (mac, ts, kind) => {
    if (!mac) return;
    const h = Math.floor((ts - start) / HOUR);
    if (h < 0 || h > 23) return;
    const m = marks.get(mac) || Array.from({ length: 24 }, () => ({ roam: 0, conn: 0, block: 0 }));
    m[h][kind] += 1;
    marks.set(mac, m);
  };
  for (const e of db.querySiemEvents(start, end, null)) {
    if (e.kind !== "log") continue;
    const key = e.data?.key || "";
    if (/ROAMED/.test(key)) add(e.mac, e.ts, "roam");
    else if (/CONNECTED|DISCONNECTED/.test(key)) add(e.mac, e.ts, "conn");
    else if (/^THREAT_|^TRAFFIC_BLOCKED/.test(key)) add(lower(e.data?.params?.SRC_CLIENT?.i) || e.mac, e.ts, "block");
  }
  return marks;
}

// ---- Day: every device as a row, the day's 24 hours as columns --------------------------
export function dayGrid({ bundle, start, end, now, today }) {
  const nameOf = insights.names();
  const hourly = new Map();
  for (const b of bundle.buckets) {
    if (b[0] < start || b[0] >= end) continue;
    const h = Math.floor((b[0] - start) / HOUR);
    if (h < 0 || h > 23) continue;
    const arr = hourly.get(b[1]) || new Array(24).fill(0);
    arr[h] += b[4] + b[5];
    hourly.set(b[1], arr);
  }
  const totals = new Map();
  for (const c of bundle.traffic) {
    totals.set(c.client.mac, c.usage.reduce((n, u) => n + (u.totalBytes || u.bytesRx + u.bytesTx), 0));
  }
  // Hours with 5-minute or hourly detail; the rest is "no data", never a quiet hour.
  const spans = bundle.bucketSpans;
  const detail = Array.from({ length: 24 }, (_, h) => {
    const a = start + h * HOUR;
    const b = Math.min(a + HOUR, now);
    if (b <= a) return null; // later today
    const covered = spans.reduce((n, [x, y]) => n + Math.max(0, Math.min(b, y) - Math.max(a, x)), 0);
    return covered / (b - a) >= 0.5;
  });
  const marks = markersFor(start, end);
  const samples = latestSamples(start, end);
  const macs = new Set([...totals.keys(), ...hourly.keys(), ...marks.keys()]);
  const rows = [...macs].map((mac) => {
    const link = linkOf(samples.get(mac), nameOf);
    return {
      mac,
      name: nameOf(mac),
      link,
      health: healthOf(link, now, today),
      hourly: hourly.get(mac) || new Array(24).fill(0),
      marks: marks.get(mac) || null,
      total: totals.get(mac) || (hourly.get(mac) || []).reduce((n, v) => n + v, 0),
    };
  });
  rows.sort((a, b) => b.total - a.total);
  const network = new Array(24).fill(0);
  for (const r of rows) r.hourly.forEach((v, i) => (network[i] += v));
  return {
    hours: Array.from({ length: 24 }, (_, h) => start + h * HOUR),
    detail,
    network: { hourly: network, total: rows.reduce((n, r) => n + r.total, 0) },
    rows,
  };
}

// ---- Network: gateway → switches / access points → devices ------------------------------
export function networkMap({ bundle, now }) {
  const nameOf = insights.names();
  const recent = latestSamples(now - 15 * 60 * 1000, now + 1);
  // Traffic in the last 15 minutes per device, as a rate.
  const rate = new Map();
  for (const b of bundle.buckets) {
    if (b[0] < now - 15 * 60 * 1000) continue;
    rate.set(b[1], (rate.get(b[1]) || 0) + b[4] + b[5]);
  }
  const devices = db.latestDeviceSamples();
  const gateway = devices.find((d) => /udm|ugw|uxg/.test(d.type || "")) || null;
  const infra = devices.filter((d) => d !== gateway);
  const node = (d) => ({
    mac: d.mac,
    name: d.name || d.model,
    type: d.type,
    model: d.model,
    online: d.state === 1,
    cpu: d.cpu,
    mem: d.mem,
    temp: d.temp,
    uptime: d.uptime,
    radios: d.data?.radios || [],
    ports: d.data?.ports || [],
    uplink: d.data?.uplink || null,
    clients: [],
  });
  const nodes = new Map();
  if (gateway) nodes.set(gateway.mac, node(gateway));
  for (const d of infra) nodes.set(d.mac, node(d));
  const loose = [];
  for (const [mac, r] of recent) {
    const link = linkOf(r, nameOf);
    const c = {
      mac,
      name: nameOf(mac),
      wired: Boolean(r.wired),
      port: r.port ?? null,
      speed: link.speed ?? null,
      signal: link.signal ?? null,
      radio: r.radio || null,
      essid: r.essid || null,
      uptime: r.uptime ?? null,
      bytes15m: rate.get(mac) || 0,
      health: healthOf(link, now, true),
    };
    const parent = nodes.get(r.ap_mac);
    if (parent) parent.clients.push(c);
    else loose.push(c);
  }
  for (const n of nodes.values()) n.clients.sort((a, b) => b.bytes15m - a.bytes15m || String(a.name).localeCompare(String(b.name)));
  const wan = db.latestWanSample();
  return {
    wan: wan ? { status: wan.status, isp: wan.isp, latency: wan.latency, availability: wan.availability, rxRate: wan.rx_rate, txRate: wan.tx_rate, ts: wan.ts } : null,
    gateway: gateway ? nodes.get(gateway.mac) : null,
    nodes: [...nodes.values()].filter((n) => !gateway || n.mac !== gateway.mac),
    loose,
  };
}

// ---- Home: findings, in plain language ----------------------------------------------------
const GB = 1e9;
const fmtGB = (b) => (b >= GB ? `${(b / GB).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);

export function findings({ bundle, start, end, now, lostSpans, clock, appName }) {
  const nameOf = insights.names();
  const out = [];
  const totalDay = bundle.traffic.reduce((n, c) => n + c.usage.reduce((m, u) => m + (u.totalBytes || u.bytesRx + u.bytesTx), 0), 0);

  // The day's biggest burst: the largest session of 5-minute rows, any device and app.
  const rows = bundle.buckets
    .filter((b) => b[0] >= start && b[0] < end)
    .map((b) => ({ t: b[0], tEnd: b[0] + (b[7] || 300000), mac: b[1], app: appName(b[2], b[3]), bytes: b[4] + b[5], domain: null }));
  const sessions = sessionize(rows, { gapMs: 10 * 60 * 1000, minBytes: 0, keyBy: "mac+app" }).sort((a, b) => b.bytes - a.bytes);
  const top = sessions[0];
  if (top && top.bytes > 2 * GB) {
    const hourly = new Array(24).fill(0);
    for (const r of rows) if (r.mac === top.mac) hourly[Math.max(0, Math.min(23, Math.floor((r.t - start) / HOUR)))] += r.bytes;
    const minutes = Math.max(1, Math.round((top.end - top.start) / 60000));
    const share = totalDay ? ` — ${Math.round((top.bytes / totalDay) * 100)}% of the day's traffic` : "";
    // A burst reads as one; a device busy all day (a torrent box) reads as the day's total.
    const burst = minutes <= 180;
    out.push({
      id: `burst-${top.mac}-${top.start}`,
      kind: "usage",
      level: "info",
      ts: top.start,
      title: burst ? `${nameOf(top.mac)} moved ${fmtGB(top.bytes)} in ${minutes} minutes` : `${nameOf(top.mac)} used ${fmtGB(top.bytes)} of ${top.app} today`,
      text: burst ? `${clock(top.start)} – ${clock(top.end)}, ${top.app}${share}.` : `Busy for ${Math.round(minutes / 60)} hours${share}.`,
      mac: top.mac,
      hourly,
      span: burst ? { from: Math.floor(top.start / HOUR) * HOUR, to: Math.floor(top.start / HOUR) * HOUR + HOUR } : null,
    });
  }

  // Weak Wi-Fi: over an hour below −80 dBm.
  for (const c of insights.wifiList(start, end).clients) {
    const poorMin = Math.round(((c.badShare || 0) / 100) * c.minutes);
    if (poorMin < 60) continue;
    out.push({
      id: `wifi-${c.mac}`,
      kind: "wifi",
      level: "warn",
      ts: c.lastSeen,
      title: `${c.name} spent ${poorMin >= 120 ? `${Math.round(poorMin / 60)} hours` : `${poorMin} minutes`} on weak Wi-Fi`,
      text: `Average ${c.avgSignal} dBm on ${c.ap}${c.roams ? `, ${c.roams} roams` : ""}. Pages start to stall below −80 dBm.`,
      mac: c.mac,
    });
  }

  // Slow or renegotiated wired links.
  for (const c of insights.wiredList(start, end).clients) {
    if (c.speed != null && c.speed <= 100) {
      out.push({ id: `link-${c.mac}`, kind: "wired", level: "warn", ts: c.lastSeen, title: `${c.name} links at only ${c.speed} Mbps`, text: `${c.switch || "Switch"}${c.port != null ? ` port ${c.port}` : ""}. Many TVs and small devices top out at 100 Mbps; a cable or port can cause it too.`, mac: c.mac });
    } else if (c.minSpeed != null && c.speed != null && c.minSpeed < c.speed) {
      out.push({ id: `drop-${c.mac}`, kind: "wired", level: "warn", ts: c.lastSeen, title: `${c.name} dropped to ${c.minSpeed} Mbps`, text: `It normally runs at ${c.speed} Mbps (${c.speedChanges} speed changes). Check the cable and port.`, mac: c.mac });
    }
  }

  // Security: each IPS hit; firewall rules grouped; repeat offenders.
  const t = insights.threats(start, end);
  for (const it of t.items.filter((i) => i.kind === "Threat blocked").slice(0, 5)) {
    out.push({ id: `threat-${it.uid}`, kind: "security", level: "bad", ts: it.ts, title: `Intrusion attempt blocked: ${it.source || "a device"} → ${it.domain || it.target || "outside"}`, text: it.signature ? `${it.signature}${it.note ? ` — ${it.note}` : ""}` : "UniFi blocked it; no connection details were caught for this one.", uid: it.uid });
  }
  const byRule = new Map();
  for (const it of t.items.filter((i) => i.kind === "Firewall block")) {
    const k = it.policy || "a firewall rule";
    const cur = byRule.get(k) || { n: 0, sources: new Set(), ts: it.ts };
    cur.n += 1;
    if (it.source) cur.sources.add(it.source);
    byRule.set(k, cur);
  }
  for (const [rule, v] of byRule) {
    out.push({ id: `rule-${rule}`, kind: "security", level: "info", ts: v.ts, title: `Your “${rule}” rule fired ${v.n === 1 ? "once" : `${v.n} times`}`, text: v.sources.size ? `From ${[...v.sources].slice(0, 3).join(", ")}${v.sources.size > 3 ? " and others" : ""}.` : "", rule });
  }
  const offenders = new Map();
  for (const it of t.items) {
    const outside = it.kind === "Threat blocked" && it.source && !isMac(it.source) && /^\d+\.\d+\.\d+\.\d+$/.test(it.source) ? it.source : null;
    if (!outside) continue;
    offenders.set(outside, (offenders.get(outside) || 0) + 1);
  }
  for (const [ip, n] of offenders) {
    if (n < 3) continue;
    out.push({ id: `offender-${ip}`, kind: "security", level: "bad", ts: now, title: `${ip} tried ${n} times`, text: "The same outside address was blocked repeatedly.", ip });
  }

  // New devices: first seen by this installation today.
  const firstSeen = db.firstSeenSince ? db.firstSeenSince(start) : [];
  for (const d of firstSeen) {
    out.push({ id: `new-${d.mac}`, kind: "device", level: "warn", ts: d.ts, title: `New device on your network: ${nameOf(d.mac)}`, text: `First seen ${clock(d.ts)}${d.wired ? " on a wired port" : " on Wi-Fi"}. If you don't recognise it, block it from its page.`, mac: d.mac });
  }

  // Equipment: offline, hot or with an update waiting.
  for (const d of db.latestDeviceSamples()) {
    if (d.state !== 1) out.push({ id: `dev-off-${d.mac}`, kind: "equipment", level: "bad", ts: d.ts, title: `${d.name || d.model} is offline`, text: "UniFi reports it disconnected.", device: d.mac });
    else if (d.temp != null && d.temp >= 80) out.push({ id: `dev-hot-${d.mac}`, kind: "equipment", level: "warn", ts: d.ts, title: `${d.name || d.model} runs hot: ${Math.round(d.temp)} °C`, text: "Check its airflow.", device: d.mac });
    if (d.data?.upgradable) out.push({ id: `dev-fw-${d.mac}`, kind: "equipment", level: "info", ts: d.ts, title: `Firmware update available for ${d.name || d.model}`, text: d.data?.firmware ? `Running ${d.data.firmware}.` : "", device: d.mac });
  }

  // Missing data.
  if (lostSpans.length) {
    const ms = lostSpans.reduce((n, s) => n + (Math.min(s.to, now) - s.from), 0);
    if (ms >= HOUR) out.push({ id: "lost", kind: "data", level: "info", ts: lostSpans[0].from, title: `${Math.round(ms / HOUR)} h of this day were never saved`, text: "UniFi had already deleted that detail before NetLens could read it; those hours show as no data." });
  }

  const order = { bad: 0, warn: 1, info: 2 };
  out.sort((a, b) => order[a.level] - order[b.level] || b.ts - a.ts);
  return out;
}
