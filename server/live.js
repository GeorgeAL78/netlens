// Live traffic (UU-C-256): the internet line, the busiest devices and every switch / gateway
// port, read from UniFi every few seconds while someone has a live view open, and pushed to
// them as Server-Sent Events. Nothing is stored: the last 15 minutes stay in memory for a view
// that opens later. With nobody watching, nothing is read.
//
// UniFi's rates ("-r" fields, bytes per second) are its own short averages: on the owner's UCG
// Fiber the internet line's refreshed about every 5 seconds, devices' about every second. Each
// read is three small requests (stat/health, stat/sta, stat/device; ~50 ms each there).
import * as unifi from "./unifi.js";
import * as db from "./db.js";

const TICK_MS = 2500;
const KEEP_MS = 15 * 60 * 1000;
const viewers = new Set();
const points = []; // { ts, down, up } in bits per second, the internet line
// Per device and per port, the last 15 minutes (UU-C-258): small graphs beside each, and the line
// a click draws over the main graph. Key: a device's MAC, or "<switch MAC>|<port>".
const devSeries = new Map(); // mac -> { name, via, port, wired, pts: [[ts, down, up]] }
const portSeries = new Map(); // key -> { device, mac, idx, on, speed, wan, pts: [[ts, toDevice, fromDevice]] }
let latest = null; // the newest full frame
let timer = null;
let busy = false;
let lastError = null;

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const lower = (v) => String(v || "").toLowerCase();

// Demo / offline: a made-up line and devices, so the page and its screenshots work without a
// console (NETLENS_OFFLINE=1 never contacts UniFi).
function demoFrame(ts) {
  const s = ts / 1000;
  const wave = (a, f, p = 0) => Math.max(0, a * (0.55 + 0.45 * Math.sin(s / f + p)));
  const down = wave(180e6, 9) + wave(60e6, 2.3, 1);
  const up = wave(18e6, 7, 2) + wave(4e6, 1.7);
  const devices = [
    { mac: "demo-1", name: "Media server", via: "Office switch", down: wave(120e6, 9), up: wave(9e6, 7, 2) },
    { mac: "demo-2", name: "Laptop", via: "Living room AP", down: wave(45e6, 2.3, 1), up: wave(3e6, 1.7) },
    { mac: "demo-3", name: "Living room TV", via: "Gateway", down: wave(25e6, 5, 3), up: 2e5 },
    { mac: "demo-4", name: "Phone", via: "Upstairs AP", down: wave(6e6, 3, 4), up: wave(1e6, 2) },
  ];
  const ports = [
    { device: "Gateway", mac: "demo-gw", ports: [{ idx: 1, on: "Living room TV", speed: 100, toDevice: devices[2].down, fromDevice: devices[2].up }, { idx: 4, on: "internet", wan: true, speed: 1000, toDevice: up, fromDevice: down }] },
    { device: "Office switch", mac: "demo-sw", ports: [{ idx: 2, on: "Media server", speed: 2500, toDevice: devices[0].down, fromDevice: devices[0].up }, { idx: 3, on: "Office PC", speed: 2500, toDevice: 1e5, fromDevice: 5e4 }] },
  ];
  return { ts, down, up, devices, ports, demo: true };
}

async function readFrame(ts) {
  if (process.env.NETLENS_OFFLINE === "1") return demoFrame(ts);
  const [health, stations, devices] = await Promise.all([unifi.getHealth(), unifi.getStations(), unifi.getDevices()]);
  const wan = health.find((h) => h.subsystem === "wan") || {};
  const names = new Map(devices.map((d) => [lower(d.mac), d.name || d.model]));
  const stored = new Map(db.listStoredClients().map((c) => [lower(c.mac), c.name || c.hostname]));
  const nameOf = (c) => stored.get(lower(c.mac)) || c.name || c.hostname || c.mac;
  // Devices: tx is what the network sent to the device (its download), rx what it sent.
  const devs = stations
    .map((c) => {
      const down = c.is_wired ? n(c["wired-tx_bytes-r"]) : n(c["tx_bytes-r"]);
      const up = c.is_wired ? n(c["wired-rx_bytes-r"]) : n(c["rx_bytes-r"]);
      return { mac: lower(c.mac), name: nameOf(c), via: names.get(lower(c.is_wired ? c.sw_mac : c.ap_mac)) || null, port: c.is_wired ? c.sw_port ?? null : null, wired: Boolean(c.is_wired), down: down * 8, up: up * 8 };
    })
    .filter((d) => d.down + d.up > 0)
    .sort((a, b) => b.down + b.up - (a.down + a.up))
    .slice(0, 12);
  // What is on each port: equipment linked there, else the wired devices UniFi lists on it.
  const onPort = new Map();
  for (const c of stations) if (c.is_wired && c.sw_mac && c.sw_port != null) {
    const k = `${lower(c.sw_mac)}|${c.sw_port}`;
    if (!onPort.has(k)) onPort.set(k, nameOf(c));
  }
  for (const d of devices) if (d.uplink?.uplink_mac && d.uplink.uplink_remote_port != null) onPort.set(`${lower(d.uplink.uplink_mac)}|${d.uplink.uplink_remote_port}`, d.name || d.model);
  const ports = devices
    .filter((d) => (d.port_table || []).length)
    .map((d) => ({
      device: d.name || d.model,
      mac: lower(d.mac),
      // rx = into the port from the device on it, tx = out of the port to it.
      ports: d.port_table
        .filter((p) => p.up)
        .map((p) => ({ idx: n(p.port_idx), on: /^wan/i.test(p.network_name || "") ? "internet" : onPort.get(`${lower(d.mac)}|${p.port_idx}`) || null, wan: /^wan/i.test(p.network_name || "") || undefined, speed: n(p.speed) || null, toDevice: n(p["tx_bytes-r"]) * 8, fromDevice: n(p["rx_bytes-r"]) * 8 })),
    }));
  return { ts, down: n(wan["rx_bytes-r"]) * 8, up: n(wan["tx_bytes-r"]) * 8, devices: devs, ports };
}

const r = (v) => Math.round(v || 0);
function remember(frame) {
  const ts = frame.ts;
  for (const d of frame.devices || []) {
    const e = devSeries.get(d.mac) || { pts: [] };
    Object.assign(e, { name: d.name, via: d.via, port: d.port ?? null, wired: Boolean(d.wired) });
    e.pts.push([ts, r(d.down), r(d.up)]);
    devSeries.set(d.mac, e);
  }
  for (const g of frame.ports || []) {
    for (const p of g.ports) {
      const k = `${g.mac}|${p.idx}`;
      const e = portSeries.get(k) || { pts: [] };
      Object.assign(e, { device: g.device, mac: g.mac, idx: p.idx, on: p.on, speed: p.speed, wan: Boolean(p.wan) });
      e.pts.push([ts, r(p.toDevice), r(p.fromDevice)]);
      portSeries.set(k, e);
    }
  }
  for (const m of [devSeries, portSeries]) {
    for (const [k, e] of m) {
      while (e.pts.length && e.pts[0][0] < ts - KEEP_MS) e.pts.shift();
      if (!e.pts.length) m.delete(k);
    }
  }
}

// The hour before, from what NetLens already records (UU-C-258): Network 11's 5-minute totals as
// an average rate, else the rate at each update; so the graph is full the moment it opens.
function coarse(now) {
  const from = now - 60 * 60e3;
  if (process.env.NETLENS_OFFLINE === "1") {
    // The demo's records are hours apart from "now"; a made-up hour instead.
    const out = [];
    const until = points[0]?.ts ?? now;
    for (let t = from; t < until; t += 60e3) out.push({ ts: t, down: r(demoFrame(t).down * 0.8), up: r(demoFrame(t).up * 0.8) });
    return out;
  }
  const engine = db.wanEngineIn(from, now);
  if (engine.length) return engine.filter((e) => e.duration > 0).map((e) => ({ ts: e.ts + e.duration, down: r(((e.rxBytes || 0) * 8 * 1000) / e.duration), up: r(((e.txBytes || 0) * 8 * 1000) / e.duration) }));
  return db.queryWanSamples(from, now).filter((w) => w.rx_rate != null).map((w) => ({ ts: w.ts, down: r(w.rx_rate * 8), up: r((w.tx_rate || 0) * 8) }));
}

function broadcast(frame) {
  const line = `data: ${JSON.stringify(frame)}\n\n`;
  for (const res of viewers) res.write(line);
}

async function tick() {
  if (busy) return;
  busy = true;
  const ts = Date.now();
  try {
    const frame = await readFrame(ts);
    latest = frame;
    lastError = null;
    points.push({ ts, down: frame.down, up: frame.up });
    while (points.length && points[0].ts < ts - KEEP_MS) points.shift();
    remember(frame);
    broadcast(frame);
  } catch (err) {
    lastError = err.message;
    broadcast({ ts, error: err.message });
  } finally {
    busy = false;
  }
}

function start() {
  if (timer) return;
  tick();
  timer = setInterval(tick, TICK_MS);
}
function stop() {
  clearInterval(timer);
  timer = null;
}

// GET /api/live: an event stream. The first event is the history kept so far and the newest
// frame; then one event per read. Reading stops when the last viewer leaves.
export function stream(req, res) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write(`retry: 5000\n`);
  const now = Date.now();
  const history = {
    points: points.filter((p) => p.ts >= now - KEEP_MS),
    coarse: coarse(now),
    devices: Object.fromEntries(devSeries),
    ports: Object.fromEntries(portSeries),
    latest,
    tickMs: TICK_MS,
    keepMs: KEEP_MS,
    error: lastError,
  };
  res.write(`event: history\ndata: ${JSON.stringify(history)}\n\n`);
  viewers.add(res);
  start();
  const ping = setInterval(() => res.write(`: keep-alive\n\n`), 20000);
  req.on("close", () => {
    clearInterval(ping);
    viewers.delete(res);
    if (!viewers.size) stop();
  });
}

// For checks against a console (one frame, no stream).
export { readFrame };

export const status = () => ({ viewers: viewers.size, running: Boolean(timer), points: points.length, error: lastError });
