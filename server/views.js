import * as db from "./db.js";
import * as insights from "./insights.js";
import { sessionize } from "./classify.js";
import * as wifijoins from "./wifijoins.js";
import { groupGuests } from "./guests.js";
import * as flowstore from "./flowstore.js";

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
    ? { wired: true, ip: r.ip ?? null, via: r.ap_mac ? nameOf(r.ap_mac) : null, port: r.port ?? null, speed: r.tx_rate != null ? Math.round(r.tx_rate / 1000) : null, uptime: r.uptime ?? null, ts: r.ts }
    : { wired: false, ip: r.ip ?? null, via: r.ap_mac ? nameOf(r.ap_mac) : null, signal: r.signal ?? null, radio: r.radio || null, essid: r.essid || null, uptime: r.uptime ?? null, ts: r.ts };
}

// `best`: the device's fastest wired link in 30 days. One that never linked faster than 100 Mbps
// (a TV, a smart plug) is at its usual speed, as Overview has judged it since UU-C-189 (UU-C-235).
const usualSpeed = (speed, best) => speed != null && best != null && best <= speed;
function healthOf(link, now, today, best = null) {
  if (!link) return "off";
  if (today && now - link.ts > 15 * 60 * 1000) return "off";
  if (link.wired) return link.speed != null && link.speed <= 100 && !usualSpeed(link.speed, best) ? "warn" : "ok";
  return link.signal != null && link.signal < -80 ? "warn" : "ok";
}

// Event markers per device and hour: roams/connects and blocked traffic.
function markersFor(start, end) {
  const marks = new Map();
  const add = (mac, ts, kind) => {
    if (!mac) return;
    const h = Math.floor((ts - start) / HOUR);
    if (h < 0 || h > 23) return;
    const m = marks.get(mac) || Array.from({ length: 24 }, () => ({ roam: 0, conn: 0, block: 0, fail: 0 }));
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
  // Failed Wi-Fi joins (UU-C-146).
  for (const r of db.wifiJoins(start, end)) if (r.result !== "SUCCESS") for (let i = 0; i < r.n; i += 1) add(r.mac, r.ts, "fail");
  return marks;
}

// ---- Day: every device as a row, the day's 24 hours as columns --------------------------
export function dayGrid({ bundle, start, end, now, today }) {
  const nameOf = insights.names();
  const hourly = new Map();
  const hourlySplit = new Map();
  for (const b of bundle.buckets) {
    if (b[0] < start || b[0] >= end) continue;
    const h = Math.floor((b[0] - start) / HOUR);
    if (h < 0 || h > 23) continue;
    const arr = hourly.get(b[1]) || new Array(24).fill(0);
    arr[h] += b[4] + b[5];
    hourly.set(b[1], arr);
    const split = hourlySplit.get(b[1]) || { down: new Array(24).fill(0), up: new Array(24).fill(0) };
    split.down[h] += b[4];
    split.up[h] += b[5];
    hourlySplit.set(b[1], split);
  }
  const totals = new Map();
  const splitTotals = new Map();
  // UniFi's usage record says wired or Wi-Fi for every day, even days NetLens took no
  // samples (before it was installed, or while it was off).
  const wiredFlag = new Map();
  for (const c of bundle.traffic) {
    totals.set(c.client.mac, c.usage.reduce((n, u) => n + (u.totalBytes || u.bytesRx + u.bytesTx), 0));
    splitTotals.set(c.client.mac, { down: c.usage.reduce((n, u) => n + u.bytesRx, 0), up: c.usage.reduce((n, u) => n + u.bytesTx, 0) });
    if (typeof c.client.wired === "boolean") wiredFlag.set(c.client.mac, c.client.wired);
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
  const logs = insights.logHistory(start, end, null, now);
  const storedIp = new Map(db.listStoredClients().filter((c) => c.ip).map((c) => [String(c.mac).toLowerCase(), c.ip]));
  const macs = new Set([...totals.keys(), ...hourly.keys(), ...marks.keys()]);
  const fastest = db.fastestWiredLinks([...macs].filter((m) => samples.get(m)?.wired), end - 30 * 86400e3);
  // A wired device's busiest 5 minutes on its port that day (UU-C-239), once per switch.
  // From when the device arrived on that port, if that day (UU-C-248).
  const peaksOf = new Map();
  const occOf = new Map();
  const busiestOf = (s) => {
    if (!s?.wired || !s.ap_mac || s.port == null) return undefined;
    if (!occOf.has(s.ap_mac)) occOf.set(s.ap_mac, insights.portOccupancy(s.ap_mac, start - 2 * 3600e3, end));
    const o = occOf.get(s.ap_mac).get(s.port);
    const from = o && o.current === s.mac && o.since ? Math.max(start, o.since) : start;
    const key = `${s.ap_mac}|${from}`;
    if (!peaksOf.has(key)) peaksOf.set(key, insights.portPeaks(s.ap_mac, from, end));
    const p = peaksOf.get(key).get(s.port);
    return p && !p.uplink && p.bps > 0 ? { bps: p.bps, share: p.share, speed: p.speed, from: p.from, at: p.at, dir: p.dir } : undefined;
  };
  const rows = [...macs].map((mac) => {
    const sampled = linkOf(samples.get(mac), nameOf);
    // No samples that day: the System Log's last word on where it was attached, unless the
    // day's usage record says the other link type (then the log is stale).
    const logged = logs.get(mac)?.link;
    const flag = wiredFlag.get(mac);
    const link =
      sampled ||
      (logged && (flag === undefined || flag === logged.wired) ? { ...logged, unsampled: true } : null) ||
      (flag !== undefined ? { wired: flag, unsampled: true } : null);
    // IP that day: a sample, else the day's System Log; failing both the last one known.
    const dayIp = sampled?.ip || logs.get(mac)?.link?.ip || null;
    const lastIp = dayIp ? null : logs.get(mac)?.link?.priorIp || storedIp.get(mac) || null;
    return {
      mac,
      name: nameOf(mac),
      ip: dayIp || lastIp,
      ipLastKnown: !dayIp && Boolean(lastIp),
      link,
      // Past days with only the log: judged on the logged signal; today it needs a sample.
      usualSpeed: link?.wired && link.speed != null && link.speed <= 100 && usualSpeed(link.speed, fastest.get(mac)) ? true : undefined,
      health: sampled ? healthOf(sampled, now, today, fastest.get(mac)) : !today && link?.via ? healthOf(link, now, false, fastest.get(mac)) : "off",
      busiest: busiestOf(samples.get(mac)),
      hourly: hourly.get(mac) || new Array(24).fill(0),
      marks: marks.get(mac) || null,
      total: totals.get(mac) || (hourly.get(mac) || []).reduce((n, v) => n + v, 0),
      down: splitTotals.get(mac)?.down ?? (hourlySplit.get(mac)?.down || []).reduce((n, v) => n + v, 0),
      up: splitTotals.get(mac)?.up ?? (hourlySplit.get(mac)?.up || []).reduce((n, v) => n + v, 0),
      hourlyDown: hourlySplit.get(mac)?.down || new Array(24).fill(0),
      hourlyUp: hourlySplit.get(mac)?.up || new Array(24).fill(0),
    };
  });
  rows.sort((a, b) => b.total - a.total);
  const network = new Array(24).fill(0);
  const networkDown = new Array(24).fill(0);
  const networkUp = new Array(24).fill(0);
  for (const r of rows) {
    r.hourly.forEach((v, i) => (network[i] += v));
    r.hourlyDown.forEach((v, i) => (networkDown[i] += v));
    r.hourlyUp.forEach((v, i) => (networkUp[i] += v));
  }
  return {
    hours: Array.from({ length: 24 }, (_, h) => start + h * HOUR),
    detail,
    network: { hourly: network, hourlyDown: networkDown, hourlyUp: networkUp, total: rows.reduce((n, r) => n + r.total, 0), down: rows.reduce((n, r) => n + r.down, 0), up: rows.reduce((n, r) => n + r.up, 0) },
    rows,
  };
}

// ---- Network: gateway → switches / access points → devices ------------------------------
// `at` (UU-C-213): the map as it was then, from the samples around it; omitted = right now.
// Each port with what went through it in the 15 minutes before t (UU-C-233), from the samples.
function portsWithTraffic(d, t) {
  const ports = d.data?.ports || [];
  if (!ports.length) return ports;
  const moved = insights.portRecentOf(d.mac, t);
  // The busiest 5 minutes in the 24 hours before t, as a share of the link (UU-C-239).
  // Busiest and dropped in the 24 hours before t (UU-C-239, UU-C-245), counted from when the
  // device now on the port arrived if that was later (UU-C-248).
  const dayAgo = t - 24 * 3600e3;
  const occ = insights.portOccupancy(d.mac, dayAgo - 2 * 3600e3, t + 1);
  const fromOf = (idx) => Math.max(dayAgo, occ.get(idx)?.since ?? 0);
  const sinces = new Set(ports.map((p) => fromOf(p.idx)));
  const peaksAt = new Map([...sinces].map((f) => [f, insights.portPeaks(d.mac, f, t)]));
  const dropsAt = new Map([...sinces].map((f) => [f, insights.portDrops(d.mac, f, t)]));
  return ports.map(({ rxBytes, txBytes, txDropped, rxDropped, txPackets, rxPackets, ...p }) => {
    const m = moved.get(p.idx);
    const f = fromOf(p.idx);
    const k = peaksAt.get(f).get(p.idx);
    const x = dropsAt.get(f).get(p.idx);
    return {
      ...p,
      ...(m ? { toDevice15m: m.toDevice, fromDevice15m: m.fromDevice } : {}),
      ...(f > dayAgo ? { since: f } : {}),
      ...(k && k.bps > 0 ? { peak24h: { bps: k.bps, share: k.share, at: k.at } } : {}),
      ...(x ? { drops24h: { toDevice: x.toDevice, fromDevice: x.fromDevice, share: insights.dropShare(x) } } : {}),
    };
  });
}

export function networkMap({ bundle, now, at = null }) {
  const t = at ?? now;
  const nameOf = insights.names();
  const recent = latestSamples(t - 15 * 60 * 1000, t + 1);
  // Traffic in the last 15 minutes per device, as a rate.
  const rate = new Map();
  const rateDown = new Map();
  const rateUp = new Map();
  for (const b of bundle.buckets) {
    if (b[0] < t - 15 * 60 * 1000 || (at != null && b[0] >= at)) continue;
    rate.set(b[1], (rate.get(b[1]) || 0) + b[4] + b[5]);
    rateDown.set(b[1], (rateDown.get(b[1]) || 0) + b[4]);
    rateUp.set(b[1], (rateUp.get(b[1]) || 0) + b[5]);
  }
  const devices = at != null ? db.deviceSamplesAt(at) : db.latestDeviceSamples();
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
    ports: portsWithTraffic(d, t),
    uplink: d.data?.uplink || null,
    overheating: d.data?.overheating === true,
    // UU-C-229: firmware and the rest of what UniFi knows about the device.
    firmware: d.data?.version || d.data?.firmware || null,
    upgradable: d.data?.upgradable === true,
    upgradeTo: d.data?.upgradeTo || null,
    eol: d.data?.eol === true,
    modelCode: d.data?.modelCode && d.data.modelCode !== d.model ? d.data.modelCode : null,
    ip: d.data?.ip || null,
    satisfaction: d.data?.satisfaction ?? null,
    poeMax: d.data?.poeMax ?? null,
    poeUsed: d.data?.poeUsed ?? null,
    clients: [],
  });
  const nodes = new Map();
  if (gateway) nodes.set(gateway.mac, node(gateway));
  for (const d of infra) nodes.set(d.mac, node(d));
  const loose = [];
  const fastest = db.fastestWiredLinks([...recent].filter(([, r]) => r.wired).map(([mac]) => mac), t - 30 * 86400e3);
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
      down15m: rateDown.get(mac) || 0,
      up15m: rateUp.get(mac) || 0,
      health: healthOf(link, t, true, fastest.get(mac)),
    };
    if (c.wired && c.speed != null && c.speed <= 100 && usualSpeed(c.speed, fastest.get(mac))) c.usualSpeed = true;
    const parent = nodes.get(r.ap_mac);
    if (parent) parent.clients.push(c);
    else loose.push(c);
  }
  // A switch forgets a quiet device's port, and UniFi then reports only the uplink it last saw
  // the address on (a container drawn on the gateway's cable to the switch) or nothing at all.
  // Such a device goes back to the last exact place NetLens recorded for it in 30 days, marked
  // as remembered (UU-C-168). Before the grouping, so it sees the corrected port.
  const macOfName = new Map([...nodes.values()].map((n) => [n.name, n.mac]));
  const uplinkKeys = new Set();
  for (const n of nodes.values()) {
    const parent = n.uplink?.device && macOfName.get(n.uplink.device);
    if (parent && n.uplink.port != null) uplinkKeys.add(`${parent}|${n.uplink.port}`);
  }
  const misplaced = [];
  for (const n of nodes.values()) for (const c of n.clients) if (c.wired && uplinkKeys.has(`${n.mac}|${c.port}`)) misplaced.push([c, n]);
  for (const c of loose) if (c.wired) misplaced.push([c, null]);
  if (misplaced.length) {
    const hits = db.lastExactPlaces(misplaced.map(([c]) => c.mac), t - 30 * 86400e3, uplinkKeys, t);
    for (const [c, from] of misplaced) {
      const hit = hits.get(c.mac);
      const to = hit && nodes.get(hit.apMac);
      if (!to) continue;
      const nowAt = from ? `somewhere behind ${from.name} port ${c.port}` : "not on any port UniFi can see";
      if (from) from.clients = from.clients.filter((x) => x !== c);
      else loose.splice(loose.indexOf(c), 1);
      c.port = hit.port;
      c.placed = { from: "memory", ts: hit.ts, nowAt };
      to.clients.push(c);
    }
  }
  // A 100 Mbps port is not a problem when everything on it is at its usual speed (UU-C-235).
  // Equipment on a port (a switch, an access point) still counts as slow.
  for (const n of nodes.values()) {
    const onPort = new Map();
    for (const c of n.clients) if (c.wired && c.port != null) onPort.set(c.port, [...(onPort.get(c.port) || []), c]);
    for (const k of nodes.values()) if (k.uplink?.device === n.name && k.uplink.port != null) onPort.set(k.uplink.port, [...(onPort.get(k.uplink.port) || []), null]);
    for (const p of n.ports) {
      const on = onPort.get(p.idx);
      if (p.up && p.speed && p.speed <= 100 && on?.length && on.every((c) => c?.usualSpeed)) p.usualSpeed = true;
    }
  }
  // Containers and VMs under the device that runs them (UU-C-165).
  const vendors = new Map(db.listStoredClients().map((c) => [String(c.mac).toLowerCase(), c.vendor || null]));
  groupGuests([...nodes.values()], loose, vendors, t);
  // Wi-Fi: weak signal first, then by traffic; wired by traffic (UU-C-165).
  for (const n of nodes.values())
    n.clients.sort(
      (a, b) =>
        Number(!a.wired && a.health === "warn" ? 0 : 1) - Number(!b.wired && b.health === "warn" ? 0 : 1) ||
        b.bytes15m - a.bytes15m ||
        String(a.name).localeCompare(String(b.name))
    );
  const wan = at != null ? db.wanSampleAt(at) : db.latestWanSample();
  const ipRuns = db.publicIpRuns(t - 90 * 86400e3).filter((r) => r.from <= t).map((r) => (r.to > t ? { ...r, to: t } : r));
  return {
    at,
    wan: wan
      ? { status: wan.status, isp: wan.isp, latency: wan.latency, availability: wan.availability, availabilityPeriod: wan.data?.period ?? null, rxRate: wan.rx_rate, txRate: wan.tx_rate, ip: wan.data?.ip || null, ts: wan.ts, ipHistory: ipRuns.slice(-12).reverse() }
      : null,
    gateway: gateway ? nodes.get(gateway.mac) : null,
    nodes: [...nodes.values()].filter((n) => !gateway || n.mac !== gateway.mac),
    loose,
  };
}

// ---- Home: findings, in plain language ----------------------------------------------------
const GB = 1e9;
const IN_USE_BYTES_PER_HOUR = 500e6;
const fmtGB = (b) => (b >= GB ? `${(b / GB).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);

// Time spent per part of the Overview, for its Server-Timing header (UU-C-215): read from the
// owner's server through the API, since a profile can only be taken on dev.
export let lastTimings = [];
// The period's blocked total from the same insights.threats call, so the Overview's "Blocked"
// count does not build every incident a second time (UU-C-215).
export let lastThreats = null;
function lapper() {
  const laps = [];
  let t0 = performance.now();
  lastTimings = laps;
  return (name) => {
    const t = performance.now();
    laps.push([name, t - t0]);
    t0 = t;
  };
}

export function findings({ bundle, start, end, now, lostSpans, clock, appName, catName = () => "", dayKey, today, days }) {
  const lap = lapper();
  const when = today ? "today" : days ? `in these ${days} days` : "that day";
  const nameOf = insights.names();
  const out = [];
  const totalDay = bundle.traffic.reduce((n, c) => n + c.usage.reduce((m, u) => m + (u.totalBytes || u.bytesRx + u.bytesTx), 0), 0);

  // Plumbing (protocols, CDNs, unclassified) is not "an app" in a sentence (UU-C-127).
  const plumbing = (app, cat) =>
    !/^Calls\b/.test(app) && (/^(Network protocols|Unknown)$/.test(cat || "") || /^(HTTPS?|SSL\/TLS|DTLS|QUIC|DNS|Unidentified)$|\b(CDN|Akamai|CloudFront|Cloudflare|Fastly|Static Content|User Content|APIs?)\b/i.test(app));
  const nDays = days ? Number(days) : 1; // a range runs from midnight days-1 ago to now
  // Bars for a card: hours for one day, days for a range (UU-C-127).
  // One direction of barsFor: a bucket's index 4 is down, 5 is up (UU-C-191).
  const splitBars = (mac, i) => {
    const n = days ? nDays : 24;
    const step = days ? 24 * HOUR : HOUR;
    const v = new Array(n).fill(0);
    for (const b of bundle.buckets) if (b[1] === mac && b[0] >= start && b[0] < end) v[Math.max(0, Math.min(n - 1, Math.floor((b[0] - start) / step)))] += b[i];
    return v;
  };
  const barsFor = (mac) => {
    const n = days ? nDays : 24;
    const step = days ? 24 * HOUR : HOUR;
    const v = new Array(n).fill(0);
    for (const b of bundle.buckets) if (b[1] === mac && b[0] >= start && b[0] < end) v[Math.max(0, Math.min(n - 1, Math.floor((b[0] - start) / step)))] += b[4] + b[5];
    return v;
  };

  // Per device and per app over the period, from UniFi's usage (the Usage page's numbers).
  const byDevice = new Map();
  const byApp = new Map();
  for (const c of bundle.traffic) {
    const mac = c.client.mac;
    for (const u of c.usage) {
      const b = u.totalBytes || u.bytesRx + u.bytesTx;
      const app = appName(u.appId, u.catId);
      const cat = catName(u.catId);
      const d = byDevice.get(mac) || { mac, bytes: 0, down: 0, up: 0, apps: new Map(), other: new Map() };
      d.bytes += b;
      d.down += u.bytesRx;
      d.up += u.bytesTx;
      (plumbing(app, cat) ? d.other : d.apps).set(app, (d.apps.get(app) || d.other.get(app) || 0) + b);
      byDevice.set(mac, d);
      if (!plumbing(app, cat)) {
        const a = byApp.get(app) || { app, cat, bytes: 0, down: 0, up: 0, devices: new Map() };
        a.bytes += b;
        a.down += u.bytesRx;
        a.up += u.bytesTx;
        a.devices.set(mac, (a.devices.get(mac) || 0) + b);
        byApp.set(app, a);
      }
    }
  }
  // A device's main app only when it is a real part of its traffic (UU-C-170): tower.lan's
  // 237 GB of Real-Debrid downloads were "SSL/TLS" to UniFi, and the card named its 1.3 GB of
  // GitHub (container updates) instead.
  const mainApp = (d) => {
    const top = [...(d?.apps || new Map()).entries()].sort((x, y) => y[1] - x[1])[0];
    return top && top[1] >= 0.2 * d.bytes ? top[0] : null;
  };
  // When UniFi only says "encrypted", the connection records usually name the destination.
  const periodDays = [];
  for (let t = start; t < end; t += 6 * HOUR) {
    const k = dayKey ? dayKey(t) : null;
    if (k && !periodDays.includes(k)) periodDays.push(k);
  }
  const topDestination = (d) => {
    if (!periodDays.length) return null;
    const by = new Map();
    for (const g of flowstore.groups(periodDays, d.mac)) {
      // A bare address names nothing a person would recognise.
      if (!g.app || g.category === "Local network" || /^(Unidentified|DNS|HTTPS?)$/.test(g.app) || /^[\d.:]+$/.test(g.app)) continue;
      by.set(g.app, (by.get(g.app) || 0) + g.bytes);
    }
    const top = [...by].sort((a, b) => b[1] - a[1])[0];
    return top && top[1] >= 0.2 * d.bytes ? `mostly ${top[0]}` : null;
  };
  // No real app: say what the traffic is — unidentified usually means a VPN (WireGuard).
  const whatItIs = (d) => {
    const top = [...(d?.other || new Map()).entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
    return top === "Unidentified" || !top ? "unidentified — VPN or encrypted" : top;
  };
  const pct = (b) => (totalDay ? Math.round((b / totalDay) * 100) : 0);
  const topDevices = [...byDevice.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 5);
  if (topDevices.length > 1) {
    out.push({
      id: `top-devices-${start}`,
      kind: "usage",
      level: "info",
      ts: start,
      title: `Top devices ${when}: ${nameOf(topDevices[0].mac)} ${fmtGB(topDevices[0].bytes)}, ${nameOf(topDevices[1].mac)} ${fmtGB(topDevices[1].bytes)}${topDevices[2] ? ", …" : ""}`,
      text: null,
      // A device with no recognisable app is usually encrypted end to end (a VPN).
      list: topDevices.map((d) => ({ label: nameOf(d.mac), sub: [mainApp(d) || topDestination(d) || whatItIs(d), `${pct(d.bytes)}% of all traffic`].join(" · "), value: fmtGB(d.bytes), down: d.down, up: d.up, mac: d.mac })),
    });
  }
  const topApps = [...byApp.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 5);
  if (topApps.length > 1) {
    out.push({
      id: `top-apps-${start}`,
      kind: "usage",
      level: "info",
      ts: start,
      title: `Top apps ${when}: ${topApps[0].app} ${fmtGB(topApps[0].bytes)}, ${topApps[1].app} ${fmtGB(topApps[1].bytes)}${topApps[2] ? ", …" : ""}`,
      text: "Protocols and unclassified traffic left out.",
      list: topApps.map((a) => {
        const dev = [...a.devices.entries()].sort((x, y) => y[1] - x[1])[0];
        return { label: a.app, sub: dev ? `mostly ${nameOf(dev[0])}` : a.cat, value: fmtGB(a.bytes), down: a.down, up: a.up, app: a.app };
      }),
    });
  }

  lap("top");
  // Unusual: a device far above its own normal, from UniFi's daily totals of the 14 days
  // before the period (UU-C-127). Today is compared while still under way, so only a device
  // already past 3x a whole normal day is flagged.
  if (dayKey) {
    const firstDay = dayKey(start - 14 * 24 * HOUR);
    const lastDay = dayKey(start - 1);
    const history = new Map();
    for (const r of db.queryDailyDevice(firstDay, lastDay, null)) {
      const list = history.get(r.mac) || [];
      list.push((r.rx || 0) + (r.tx || 0));
      history.set(r.mac, list);
    }
    const median = (xs) => {
      const v = [...xs].sort((a, b) => a - b);
      return v.length ? v[Math.floor(v.length / 2)] : 0;
    };
    for (const d of byDevice.values()) {
      const h = history.get(d.mac);
      if (!h || h.length < 5) continue; // too little history to know "usual"
      const usual = median(h) * nDays;
      if (usual > 0 && d.bytes > 3 * usual && d.bytes - usual > 2 * GB) {
        out.push({
          id: `unusual-${d.mac}-${start}`,
          kind: "usage",
          level: "warn",
          ts: start,
          title: `${nameOf(d.mac)} used ${(d.bytes / usual).toFixed(1)}× its usual ${when}`,
          text: `${fmtGB(d.bytes)}, against about ${fmtGB(usual)} on a normal ${days ? `${nDays} days` : "day"}${mainApp(d) ? `; mostly ${mainApp(d)}` : topDestination(d) ? `; ${topDestination(d)}` : ""}.`,
          mac: d.mac,
          hourly: barsFor(d.mac),
          hourlyDown: splitBars(d.mac, 4),
          hourlyUp: splitBars(d.mac, 5),
          barDays: days ? nDays : null,
        });
      }
    }
  }

  lap("unusual");
  // The day's biggest burst: the largest session of 5-minute rows, any device and app.
  const rows = bundle.buckets
    .filter((b) => b[0] >= start && b[0] < end)
    .map((b) => ({ t: b[0], tEnd: b[0] + (b[7] || 300000), mac: b[1], app: appName(b[2], b[3]), bytes: b[4] + b[5], domain: null }));
  const sessions = sessionize(rows, { gapMs: 10 * 60 * 1000, minBytes: 0, keyBy: "mac+app" }).sort((a, b) => b.bytes - a.bytes);
  const top = sessions[0];
  if (top && top.bytes > 2 * GB) {
    const hourly = barsFor(top.mac);
    const minutes = Math.max(1, Math.round((top.end - top.start) / 60000));
    const share = totalDay ? ` — ${Math.round((top.bytes / totalDay) * 100)}% of ${days ? "all" : "the day's"} traffic` : "";
    // A burst reads as one; a device busy all day (a torrent box) reads as the day's total.
    const burst = minutes <= 180;
    out.push({
      id: `burst-${top.mac}-${top.start}`,
      kind: "usage",
      level: "info",
      ts: top.start,
      // Name the app only when it is one (not "of Unidentified", UU-C-127).
      title: burst
        ? `${nameOf(top.mac)} moved ${fmtGB(top.bytes)} in ${minutes} minutes`
        : plumbing(top.app, "")
          ? `${nameOf(top.mac)} moved ${fmtGB(top.bytes)} in one long stretch ${when}`
          : `${nameOf(top.mac)} used ${fmtGB(top.bytes)} of ${top.app} ${when}`,
      text:
        (burst ? `${clock(top.start)} – ${clock(top.end)}${plumbing(top.app, "") ? "" : `, ${top.app}`}${share}.` : `Busy for ${Math.round(minutes / 60)} hours${share}.`) +
        (top.app === "Unidentified" ? " UniFi can't see what it is — encrypted traffic, for example a WireGuard VPN." : ""),
      mac: top.mac,
      hourly,
      hourlyDown: splitBars(top.mac, 4),
      hourlyUp: splitBars(top.mac, 5),
      barDays: days ? nDays : null,
      span: burst ? { from: Math.floor(top.start / HOUR) * HOUR, to: Math.floor(top.start / HOUR) * HOUR + HOUR } : null,
    });
  }

  lap("burst");
  // Weak Wi-Fi: over an hour below −80 dBm.
  // One read of the period's client samples for Wi-Fi and wired both (UU-C-217).
  const clientSamples = db.queryClientSamples(start, end, null);
  for (const c of insights.wifiList(start, end, clientSamples).clients) {
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

  lap("weakwifi");
  // Access points on one channel (UU-C-198). An hour or more, so a channel scan or a brief change
  // stays quiet; only when a radio carries devices. Both busy is worth acting on.
  for (const p of insights.channelOverlaps(start, end)) {
    const minutes = Math.round(p.ms / 60000);
    if (minutes < 60 || (!p.clientsA && !p.clientsB)) continue;
    const same = p.a.channel === p.b.channel;
    const now_ = today && p.current;
    const verb = same ? (now_ ? "share" : "shared") : now_ ? "overlap on" : "overlapped on";
    const span = minutes >= 2880 ? `${Math.round(minutes / 1440)} days` : minutes >= 120 ? `${Math.round(minutes / 60)} hours` : `${minutes} minutes`;
    out.push({
      id: `channel-${p.key}`,
      kind: "wifi",
      level: p.clientsA && p.clientsB ? "warn" : "info",
      ts: p.ts,
      title: `${p.a.name} and ${p.b.name} ${verb} ${p.band} GHz ${same ? `channel ${p.a.channel}` : `channels ${p.a.channel} and ${p.b.channel}`}`,
      text: `For ${span} ${when}. Radios that can hear each other on one channel take turns to transmit, which slows both and can garble video. Give them separate channels in UniFi${p.band === "2.4" ? " (1, 6 and 11 do not overlap)" : ""}; a channel lock such as IoT Optimization can cause this.`,
      device: p.a.mac,
    });
  }

  lap("channels");
  // Failed Wi-Fi joins (UU-C-146): only when it is worth a look — 20+ in the period, or more
  // failures than successful joins. One-offs stay on the device page.
  const JOIN_PHRASE = { login: "couldn't log in to Wi-Fi", refused: "was refused by an access point", noip: "joined Wi-Fi but got no IP address", dns: "joined Wi-Fi but its DNS lookups failed", other: "failed to join Wi-Fi" };
  for (const d of wifijoins.summary(start, end)) {
    if (!(d.fails >= 20 || (d.fails >= 5 && d.fails > d.joins))) continue;
    const p = d.problems[0];
    const aps = p.aps.map((a) => a.name).join(", ");
    out.push({
      id: `join-${d.mac}`,
      kind: "wifi",
      level: "warn",
      ts: d.lastFail,
      title: `${d.name} ${JOIN_PHRASE[p.key]} ${p.n} time${p.n === 1 ? "" : "s"} ${when}`,
      text: `${aps ? `On ${aps}. ` : ""}${d.joins} successful join${d.joins === 1 ? "" : "s"}. ${p.hint}`,
      mac: d.mac,
    });
  }

  lap("joins");
  // Slow or renegotiated wired links.
  const wired = insights.wiredList(start, end, clientSamples).clients;
  const fastest = db.fastestWiredLinks(wired.map((c) => c.mac), end - 30 * 86400e3);
  // Each slow stretch used to scan every 5-minute row of the period for its device: 5 s of a
  // 30-day Overview on the owner's network (UU-C-217). The rows of the devices that have such
  // stretches, grouped once, in their original order, so every sum comes out the same.
  const slowMacs = new Set(wired.filter((c) => c.lowSpans?.length).map((c) => c.mac));
  const rowsOf = new Map();
  if (slowMacs.size) {
    for (const r of bundle.buckets) {
      if (!slowMacs.has(r[1])) continue;
      const list = rowsOf.get(r[1]);
      if (list) list.push(r);
      else rowsOf.set(r[1], [r]);
    }
  }
  for (const c of wired) {
    // A device that never linked faster in 30 days (a TV, a smart plug) is at its usual speed:
    // nothing to fix (UU-C-189). A slow link matters when the device used to be faster.
    const best = Math.max(fastest.get(c.mac) ?? 0, c.topSpeed ?? 0) || null;
    if (c.speed != null && best != null && best <= c.speed && !c.lowSpans?.length) continue;
    if (c.lowSpans?.length && c.topSpeed != null) {
      // Asleep or a bad link? A sleeping PC keeps its link at 10 Mbps (Wake-on-LAN) and moves
      // next to nothing; a real cable or port problem shows up while the device is busy.
      const mine = rowsOf.get(c.mac) || [];
      const bytesIn = (a, b) => mine.reduce((n, r) => (r[0] >= a && r[0] < b ? n + r[4] + r[5] : n), 0);
      const spans = c.lowSpans.map((sp) => ({ ...sp, perHour: bytesIn(sp.from, sp.to) / Math.max(1, (sp.to - sp.from) / HOUR) }));
      // A dozing PC wakes for mail and updates, up to about 200 MB an hour (UU-F-089). Somebody
      // working over a bad link moves far more.
      const busy = spans.filter((sp) => sp.perHour > IN_USE_BYTES_PER_HOUR);
      if (busy.length) {
        const b = busy[0];
        out.push({ id: `drop-${c.mac}`, kind: "wired", level: "warn", ts: b.from, title: `${c.name} dropped to ${b.speed} Mbps while in use`, text: `It normally runs at ${c.topSpeed} Mbps and was moving data at ${clock(b.from)} at the lower speed (${c.speedChanges} speed change${c.speedChanges === 1 ? "" : "s"}). Check the cable and port.`, mac: c.mac });
      } else {
        const last = spans[spans.length - 1];
        const when = spans.map((sp) => `${clock(sp.from)}${sp.recovered ? `–${clock(sp.to)}` : " on"}`).join(", ");
        // A PC that dozes all night would list a dozen times here.
        out.push({ id: `sleep-${c.mac}`, kind: "wired", level: "info", ts: last.from, title: spans.length > 3 ? `${c.name} slept ${spans.length} times, ${clock(spans[0].from)} to ${clock(last.to)}` : `${c.name} slept ${when}`, text: `Its link drops to ${Math.min(...spans.map((sp) => sp.speed))} Mbps while it sleeps, which is normal for a PC that can be woken over the network; it runs at ${c.topSpeed} Mbps when awake.`, mac: c.mac });
      }
    } else if (c.speed != null && c.speed <= 100 && best > c.speed) {
      out.push({ id: `link-${c.mac}`, kind: "wired", level: "warn", ts: c.lastSeen, title: `${c.name} links at only ${c.speed} Mbps`, text: `It linked at ${best} Mbps in the last 30 days. ${c.switch || "Switch"}${c.port != null ? ` port ${c.port}` : ""}: a cable or port is the usual cause.`, mac: c.mac });
    }
  }

  lap("wired");
  // Links near their limit (UU-C-239): a port whose busiest 5 minutes used 80% or more of its
  // speed. Up to 7 days (a month of samples per switch is slow to read for an Overview).
  if (nDays <= 7) {
    const latest = db.latestDeviceSamples();
    const equipment = latest.filter((d) => (d.data?.ports || []).length);
    // What is on each port: equipment linked to it, else the wired device seen there most.
    const onPort = new Map();
    for (const r of clientSamples) {
      if (!r.wired || !r.ap_mac || r.port == null) continue;
      const k = `${r.ap_mac}|${r.port}`;
      const m = onPort.get(k) || new Map();
      m.set(r.mac, (m.get(r.mac) || 0) + 1);
      onPort.set(k, m);
    }
    const linked = new Map();
    for (const d of latest) {
      const up = d.data?.uplink;
      const parent = up?.device && latest.find((x) => x.name === up.device);
      if (parent && up.port != null) linked.set(`${parent.mac}|${up.port}`, d.name || d.model);
    }
    const linkWord = (mbps) => (mbps >= 1000 ? `${+(mbps / 1000).toFixed(1)} Gbps` : `${mbps} Mbps`);
    const rate = (bps) => (bps >= 1e9 ? `${(bps / 1e9).toFixed(2)} Gbps` : `${Math.round(bps / 1e6)} Mbps`);
    for (const d of equipment) {
      // Each port counts from when the device now on it arrived (UU-C-248), and names that device.
      const occ = insights.portOccupancy(d.mac, start - 2 * 3600e3, end);
      const fromOf = (idx) => Math.max(start, occ.get(idx)?.since ?? 0);
      const froms = [...new Set([...(d.data?.ports || []).map((x) => fromOf(x.idx)), start])];
      const dropsFrom = new Map(froms.map((f) => [f, insights.portDrops(d.mac, f, end)]));
      const peaksFrom = new Map(froms.map((f) => [f, insights.portPeaks(d.mac, f, end)]));
      const perPort = (byFrom) => {
        const m = new Map();
        for (const x of d.data?.ports || []) {
          const v = byFrom.get(fromOf(x.idx))?.get(x.idx);
          if (v) m.set(x.idx, v);
        }
        return m;
      };
      const whoOn = (idx) => {
        const cur = occ.get(idx)?.current;
        if (cur && !linked.get(`${d.mac}|${idx}`)) return cur;
        const counts = onPort.get(`${d.mac}|${idx}`);
        return counts ? [...counts].sort((a, b) => b[1] - a[1])[0][0] : null;
      };
      // Ports throwing packets away (UU-C-245): 0.5% or more of a direction's packets, at least
      // a thousand. Usually traffic from a fast link to a slower one (2.5 Gbps toward 1 Gbps or a
      // 100 Mbps device); flow control on that device lets it ask the sender to pause instead.
      const dropFc = (d.data?.ports || []).reduce((m, x) => m.set(x.idx, x), new Map());
      for (const [idx, x] of perPort(dropsFrom)) {
        const share = insights.dropShare(x);
        if (share < 0.005 || x.toDevice + x.fromDevice < 1000) continue;
        const port = dropFc.get(idx) || {};
        const who = whoOn(idx);
        const what = port.wan ? "internet port" : linked.get(`${d.mac}|${idx}`) ? `link to ${linked.get(`${d.mac}|${idx}`)}` : who ? `port to ${nameOf(who)}` : `port ${idx}`;
        const outward = x.toDevice >= x.fromDevice;
        const fc = port.fcTx === false && port.fcRx === false ? " Flow control is off on this port." : port.fcTx || port.fcRx ? " Flow control is on." : "";
        out.push({
          id: `drops-${d.mac}-${idx}`,
          // The internet port and links between UniFi devices are the equipment (UU-C-248).
          kind: port.wan || linked.get(`${d.mac}|${idx}`) ? "equipment" : "wired",
          level: "info",
          ts: end - 1,
          title: `${d.name || d.model}'s ${what} dropped ${(share * 100).toFixed(share >= 0.1 ? 0 : 1)}% of packets`,
          text: `${(outward ? x.toDevice : x.fromDevice).toLocaleString("en-US")} packets ${outward ? (port.wan ? "going out to the internet" : "on the way to the device") : "coming in"} were thrown away ${when}${port.speed ? ` (the port runs at ${linkWord(port.speed)})` : ""}. That usually means traffic arriving faster than the link can carry; TCP slows down to cope.${fc}`,
          mac: who && !port.wan ? who : undefined,
        });
      }
      for (const [idx, p] of perPort(peaksFrom)) {
        if (!p.speed || p.share == null || p.share < 0.8) continue;
        const who = whoOn(idx);
        const what = p.wan ? "Your internet link" : linked.get(`${d.mac}|${idx}`) ? `The link to ${linked.get(`${d.mac}|${idx}`)}` : who ? nameOf(who) : `${d.name || d.model} port ${idx}`;
        const pctText = `${Math.round(p.share * 100)}%`;
        const toward = p.wan ? (p.dir === "fromDevice" ? "downloading" : "uploading") : p.dir === "toDevice" ? `toward ${who ? "it" : "the device"}` : `from ${who ? "it" : "the device"}`;
        out.push({
          id: `headroom-${d.mac}-${idx}`,
          kind: p.wan || linked.get(`${d.mac}|${idx}`) ? "equipment" : "wired",
          level: "info",
          ts: p.at,
          title: `${what} used ${pctText} of its ${linkWord(p.speed)} ${p.wan ? "line" : "link"}`,
          text: `Busiest ${Math.round((p.at - p.from) / 60e3)} minutes, ${clock(p.from)}–${clock(p.at)}: ${rate(p.bps)} ${toward}${p.wan ? "" : ` on ${d.name || d.model} port ${idx}`}. Short peaks are buffered; if it stutters or slows down then, ${p.wan ? "the line is the limit" : "a faster port, cable or Wi-Fi link would give it room"}.`,
          mac: who && !p.wan && !linked.get(`${d.mac}|${idx}`) ? who : undefined,
        });
      }
    }
  }

  lap("headroom");
  // A device moved to another port (UU-C-248): where it was and where it is, once it has stayed
  // 15 minutes. From the period's samples (already read), wired only (Wi-Fi roams all the time).
  {
    const byMac = new Map();
    for (const r of clientSamples) {
      if (!r.wired) continue;
      const list = byMac.get(r.mac) || [];
      list.push({ ts: r.ts, apMac: r.ap_mac, port: r.port, ip: r.ip });
      byMac.set(r.mac, list);
    }
    const devs = db.latestDeviceSamples();
    const uplinkKeys = new Set();
    for (const d of devs) {
      const parent = d.data?.uplink?.device && devs.find((x) => x.name === d.data.uplink.device);
      if (parent && d.data.uplink.port != null) uplinkKeys.add(`${parent.mac}|${d.data.uplink.port}`);
    }
    const place = (p) => `${nameOf(p.apMac)} port ${p.port}`;
    for (const [mac, rows] of byMac) {
      const list = insights.placeStretches(rows);
      for (let i = 1; i < list.length; i += 1) {
        const a = list[i - 1];
        const b = list[i];
        if (b.from < start) continue;
        // A switch that forgot a quiet device reports the uplink for a while; a move to or from a
        // link between UniFi devices is that, not a move (UU-C-168).
        if (uplinkKeys.has(`${a.apMac}|${a.port}`) || uplinkKeys.has(`${b.apMac}|${b.port}`)) continue;
        const net = (p) => p.network || "another network";
        if (a.apMac === b.apMac && a.port === b.port) {
          out.push({ id: `netmove-${mac}-${b.from}`, kind: "wired", level: "info", ts: b.from, title: `${nameOf(mac)} changed network: ${net(a)} → ${net(b)}`, text: `On ${place(b)}, at ${clock(b.from)}${b.ip ? `, now ${b.ip}` : ""}. Firewall rules for ${net(b)} apply to it now.`, mac });
          continue;
        }
        const nets = a.network && b.network && a.network !== b.network;
        out.push({ id: `moved-${mac}-${b.from}`, kind: "wired", level: "info", ts: b.from, title: `${nameOf(mac)} moved to ${place(b)}${nets ? ` (${b.network})` : ""}`, text: `It was on ${place(a)}${nets ? ` (${a.network})` : ""} before ${clock(b.from)}. That port's figures start over; this device's own record follows it.`, mac });
      }
    }
  }
  // Security: each IPS hit; firewall rules grouped; repeat offenders.
  const t = insights.threats(start, end);
  lastThreats = { start, end, total: t.total };
  // One finding per source → target: four attempts from one address are one story, not four.
  const groups = new Map();
  for (const it of t.items.filter((i) => i.kind === "Threat blocked")) {
    const k = `${it.source}|${it.domain || it.target}`;
    const g = groups.get(k);
    if (g) g.n += 1;
    else groups.set(k, { it, n: 1 });
  }
  for (const { it, n } of [...groups.values()].slice(0, 5)) {
    const outsideRepeat = n >= 3 && /^\d+\.\d+\.\d+\.\d+$/.test(it.source || "");
    out.push({
      id: `threat-${it.uid}`,
      kind: "security",
      level: "bad",
      ts: it.ts,
      title: outsideRepeat
        ? `${it.source} tried ${n} times to reach ${it.domain || it.target || "your network"}`
        : `Intrusion attempt${n > 1 ? `s (${n})` : ""} blocked: ${it.source || "a device"} → ${it.domain || it.target || "outside"}`,
      text: it.signature ? `${it.signature}${it.note ? ` — ${it.note}` : ""}` : outsideRepeat ? "The same outside address was blocked repeatedly." : "UniFi blocked it; no connection details were caught for this one.",
      uid: it.uid,
      ip: outsideRepeat ? it.source : undefined,
    });
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
  lap("security");
  // New devices: first seen by this installation today.
  const firstSeen = db.firstSeenSince ? db.firstSeenSince(start) : [];
  for (const d of firstSeen) {
    out.push({ id: `new-${d.mac}`, kind: "device", level: "warn", ts: d.ts, title: `New device on your network: ${nameOf(d.mac)}`, text: `First seen ${days ? new Date(d.ts).toLocaleDateString() + " " : ""}${clock(d.ts)}${d.wired ? " on a wired port" : " on Wi-Fi"}. If you don't recognise it, block it from its page.`, mac: d.mac });
  }

  lap("newdevices");
  // The public IP changed in the period (UU-C-176): after a power cut, a gateway restart or the
  // ISP renewing the address. Only a change NetLens saw, i.e. a new address after a known one.
  {
    const runs = db.publicIpRuns(start - 90 * 86400e3);
    for (let k = 1; k < runs.length; k += 1) {
      if (runs[k].from < start || runs[k].from >= end) continue;
      out.push({
        id: `ip-${runs[k].from}`,
        kind: "equipment",
        level: "info",
        ts: runs[k].from,
        title: `Public IP changed: ${runs[k - 1].ip} → ${runs[k].ip}`,
        text: `At ${clock(runs[k].from)}. Usually after a power cut, a gateway restart or the ISP renewing the address.`,
      });
    }
  }
  lap("publicip");
  // UniFi itself (UU-C-229): a Network application update NetLens saw happen, or one waiting.
  {
    let v = {};
    try {
      v = JSON.parse(db.getSetting("unifi_versions", "{}") || "{}");
    } catch {}
    const c = v.changed;
    if (c?.at >= start && c.at < end) {
      const toEleven = Number(String(c.from).split(".")[0]) < 11 && Number(String(c.to).split(".")[0]) >= 11;
      out.push({
        id: `unifi-${c.to}`,
        kind: "equipment",
        level: "info",
        ts: c.at,
        title: `UniFi Network updated: ${c.from} → ${c.to}`,
        text: toEleven
          ? "Network 11 starts UniFi's own statistics over, so UniFi's graphs begin at the update. NetLens keeps its own history, and today's traffic carries on from what it had."
          : `Seen at ${clock(c.at)}.`,
      });
    }
    if (v.updateAvailable && v.network) out.push({ id: "unifi-update", kind: "equipment", level: "info", ts: v.checkedAt || end, title: "UniFi Network update available", text: `Running ${v.network}.` });
  }
  // Equipment over the period (UU-C-248): restarts, times offline, firmware updates. Restarts that
  // come with a firmware change are the update, not trouble. More than three restarts of one
  // device read as one line.
  {
    const byMac = new Map();
    for (const r of db.equipmentTrail(start - 30 * 60e3, end)) {
      const list = byMac.get(r.mac) || [];
      list.push(r);
      byMac.set(r.mac, list);
    }
    const fmtGap = (ms) => (ms >= 2 * HOUR ? `${Math.round(ms / HOUR)} h` : `${Math.max(1, Math.round(ms / 60e3))} min`);
    const andList = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
    const offs = [];
    const gwRestarts = [];
    for (const [mac, rows] of byMac) {
      const name = rows[rows.length - 1].name || rows[rows.length - 1].model;
      const gw = /udm|ugw|uxg/.test(rows[rows.length - 1].type || "");
      const restarts = [];
      let off = null;
      for (let i = 1; i < rows.length; i += 1) {
        const a = rows[i - 1];
        const b = rows[i];
        if (b.ts < start) continue;
        if (b.fw && a.fw && b.fw !== a.fw) {
          out.push({ id: `fw-${mac}-${b.ts}`, kind: "equipment", level: "info", ts: b.ts, title: `${name}: ${gw ? "UniFi OS" : "firmware"} updated to ${b.version || b.fw}`, text: `From ${a.version || a.fw}.`, device: mac });
        }
        if (a.uptime != null && b.uptime != null && b.uptime < a.uptime) restarts.push({ ts: Math.max(a.ts, b.ts - b.uptime * 1000), update: Boolean(b.fw && a.fw && b.fw !== a.fw) });
        if (a.state === 1 && b.state !== 1) off = b.ts;
        else if (a.state !== 1 && b.state === 1 && off) {
          offs.push({ mac, name, from: off, to: b.ts });
          off = null;
        }
      }
      if (gw) for (const r of restarts) gwRestarts.push({ mac, name, ...r });
      const trouble = gw ? [] : restarts.filter((r) => !r.update);
      if (trouble.length > 3) {
        out.push({ id: `restarts-${mac}`, kind: "equipment", level: "warn", ts: trouble[trouble.length - 1].ts, title: `${name} restarted ${trouble.length} times ${when}`, text: `Last at ${clock(trouble[trouble.length - 1].ts)}. Frequent restarts point to power (PoE budget, adapter) or a crash; its history on the Network page shows each one.`, device: mac });
      } else {
        for (const r of trouble) out.push({ id: `restart-${mac}-${r.ts}`, kind: "equipment", level: "info", ts: r.ts, title: `${name} restarted`, text: `At ${clock(r.ts)}, from its own uptime. A restart after a settings change or an update in UniFi is normal.`, device: mac });
      }
    }
    // Offline at the same moment is one story (UU-C-248): when the gateway, which runs UniFi
    // Network, restarts, it loses sight of every access point and switch until they check in again
    // (on the owner's network: both access points "offline" 14:32-14:38 after the gateway's 14:22
    // restart for Network 11); devices on them usually keep working meanwhile.
    offs.sort((a, b) => a.from - b.from);
    const clusters = [];
    for (const o of offs) {
      const c = clusters[clusters.length - 1];
      if (c && o.from - c.from <= 10 * 60e3) {
        c.items.push(o);
        c.to = Math.max(c.to, o.to);
      } else clusters.push({ from: o.from, to: o.to, items: [o] });
    }
    const usedRestarts = new Set();
    for (const c of clusters) {
      const names = andList([...new Set(c.items.map((o) => o.name))]);
      const many = c.items.length > 1;
      const r = gwRestarts.find((g) => g.ts >= c.from - 30 * 60e3 && g.ts <= c.to);
      if (r) {
        usedRestarts.add(r);
        out.push({ id: `down-${r.mac}-${r.ts}`, kind: "equipment", level: "info", ts: r.ts, title: `${r.name} restarted${r.update ? " for an update" : ""}; ${names} showed offline ${fmtGap(c.to - c.from)}`, text: `The gateway restarted at ${clock(r.ts)}. It runs UniFi Network, so it lost sight of ${many ? "them" : "it"} from ${clock(c.from)} until ${many ? "they" : "it"} checked in again at ${clock(c.to)}. Devices on ${many ? "them" : "it"} usually keep working meanwhile.`, device: r.mac });
      } else if (many) {
        out.push({ id: `down-${c.items[0].mac}-${c.from}`, kind: "equipment", level: "warn", ts: c.from, title: `${names} were offline ${fmtGap(c.to - c.from)} at the same time`, text: `From ${clock(c.from)} to ${clock(c.to)}. Several at once points to what they share: the switch or gateway they hang off, or their power.` });
      } else {
        const o = c.items[0];
        out.push({ id: `down-${o.mac}-${o.from}`, kind: "equipment", level: "warn", ts: o.from, title: `${o.name} was offline ${fmtGap(o.to - o.from)}`, text: `UniFi lost it at ${clock(o.from)}; back at ${clock(o.to)}.`, device: o.mac });
      }
    }
    // The gateway's other restarts.
    for (const r of gwRestarts.filter((g) => !usedRestarts.has(g) && !g.update)) {
      out.push({ id: `restart-${r.mac}-${r.ts}`, kind: "equipment", level: "info", ts: r.ts, title: `${r.name} restarted`, text: `At ${clock(r.ts)}, from its own uptime. While it restarts the internet and UniFi Network are down for a few minutes; after a UniFi update that is normal.`, device: r.mac });
    }
  }
  // Equipment: offline, hot or with an update waiting.
  for (const d of db.latestDeviceSamples()) {
    if (d.state !== 1) out.push({ id: `dev-off-${d.mac}`, kind: "equipment", level: "bad", ts: d.ts, title: `${d.name || d.model} is offline`, text: "UniFi reports it disconnected.", device: d.mac });
    else if (d.data?.overheating) out.push({ id: `dev-hot-${d.mac}`, kind: "equipment", level: "bad", ts: d.ts, title: `${d.name || d.model} is overheating`, text: `UniFi reports it overheating${d.temp != null ? ` at ${Math.round(d.temp)} °C` : ""}. Check its airflow and what is stacked on or around it.`, device: d.mac });
    else if (d.temp != null && d.temp >= 80) out.push({ id: `dev-hot-${d.mac}`, kind: "equipment", level: "warn", ts: d.ts, title: `${d.name || d.model} runs hot: ${Math.round(d.temp)} °C`, text: "Check its airflow.", device: d.mac });
    if (d.data?.upgradable) out.push({ id: `dev-fw-${d.mac}`, kind: "equipment", level: "info", ts: d.ts, title: `Firmware update available for ${d.name || d.model}`, text: [d.data?.version || d.data?.firmware ? `Running ${d.data.version || d.data.firmware}` : null, d.data?.upgradeTo ? `${d.data.upgradeTo} is available` : null].filter(Boolean).join("; ") + ".", device: d.mac });
    if (d.data?.eol) out.push({ id: `dev-eol-${d.mac}`, kind: "equipment", level: "warn", ts: d.ts, title: `${d.name || d.model} has reached end of life`, text: "UniFi lists this model as end of life: it gets no more firmware updates.", device: d.mac });
  }

  lap("equipment");
  // Missing data.
  if (lostSpans.length) {
    const ms = lostSpans.reduce((n, s) => n + (Math.min(s.to, now) - s.from), 0);
    if (ms >= HOUR) out.push({ id: "lost", kind: "data", level: "info", ts: lostSpans[0].from, title: `${Math.round(ms / HOUR)} h of this day were never saved`, text: "UniFi had already deleted that detail before NetLens could read it; those hours show as no data." });
  }

  const order = { bad: 0, warn: 1, info: 2 };
  out.sort((a, b) => order[a.level] - order[b.level] || b.ts - a.ts);
  lap("rest");
  return out;
}
