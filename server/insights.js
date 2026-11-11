import * as db from "./db.js";

// Views over the live samples and the System Log (UU-C-056): gateway/WAN strip, equipment
// health, Wi-Fi quality per client, threats. Everything reads SQLite only — like
// /api/report, no request here ever waits on UniFi.
//
// Dwell time, favourite AP and the presence pattern use the definitions of unifi-toolkit's
// Wi-Fi Stalker (Crosstalk Solutions, MIT): minutes per AP (Wi-Fi only); the AP with the
// most minutes over 30 days, most recent winning a tie; a 24x7 grid of average minutes
// connected per hour-of-day x day-of-week, meaningful after 7 days. Ours is computed from
// 5-minute samples rather than connect/disconnect sessions, so roams within one session
// count toward the right AP.

const SAMPLE_MIN = 5;
const WEAK = -75;
const BAD = -80;
const BANDS = { ng: "2.4 GHz", na: "5 GHz", "6e": "6 GHz" };
export const bandName = (r) => BANDS[r] || r || null;

function stepFor(start, end) {
  const span = end - start;
  if (span <= 36 * 3600e3) return SAMPLE_MIN * 60e3;
  if (span <= 8 * 86400e3) return 3600e3;
  return 4 * 3600e3;
}

function bucketsOf(rows, start, end, pick) {
  const step = stepFor(start, end);
  const map = new Map();
  for (const r of rows) {
    const t = start + Math.floor((r.ts - start) / step) * step;
    const list = map.get(t);
    if (list) list.push(r);
    else map.set(t, [r]);
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([t, list]) => ({ t, ...pick(list) }));
}

const avg = (xs) => {
  const v = xs.filter((x) => x != null);
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
};
const minOf = (xs) => {
  const v = xs.filter((x) => x != null);
  return v.length ? Math.min(...v) : null;
};

export function names() {
  const byMac = new Map();
  for (const c of db.listStoredClients()) if (c.mac) byMac.set(String(c.mac).toLowerCase(), c.name || c.hostname || c.mac);
  for (const [m, n] of db.siemNamesByMac()) if (!byMac.has(m)) byMac.set(m, n);
  for (const d of db.latestDeviceSamples()) if (d.mac && d.name) byMac.set(d.mac, d.name);
  return (mac) => byMac.get(String(mac || "").toLowerCase()) || mac || null;
}

// ---- gateway / WAN strip --------------------------------------------------------------

export function gatewayStatus() {
  const wan = db.latestWanSample();
  const gw = db.latestDeviceSamples().find((d) => ["udm", "ugw", "uxg"].includes(d.type)) || null;
  const now = Date.now();
  const day = db.queryWanSamples(now - 24 * 3600e3, now + 1);
  return {
    sampledAt: wan?.ts || null,
    status: wan?.status || null,
    isp: wan?.isp || null,
    latency: wan?.latency ?? null,
    availability: wan?.availability ?? null,
    monitors: wan?.data?.monitors || [],
    clients: wan?.data?.clients || null,
    gateway: gw ? { name: gw.name, cpu: gw.cpu, mem: gw.mem, temp: gw.temp, uptime: gw.uptime } : null,
    day: {
      latencyAvg: avg(day.map((r) => r.latency)),
      latencyMax: day.length ? Math.max(...day.map((r) => r.latency ?? 0)) : null,
      availabilityMin: minOf(day.map((r) => r.availability)),
      samples: day.length,
    },
  };
}

// ---- equipment health -----------------------------------------------------------------

export function equipment(start, end) {
  const rows = db.queryDeviceSamples(start, end);
  const byMac = new Map();
  for (const r of rows) {
    const list = byMac.get(r.mac);
    if (list) list.push(r);
    else byMac.set(r.mac, [r]);
  }
  const latest = new Map(db.latestDeviceSamples().map((d) => [d.mac, d]));
  const devices = [...new Set([...latest.keys(), ...byMac.keys()])].map((mac) => {
    const list = byMac.get(mac) || [];
    const last = latest.get(mac) || list[list.length - 1];
    const radios = [...new Set(list.flatMap((r) => (r.data.radios || []).map((x) => x.radio)))];
    return {
      mac,
      name: last?.name,
      type: last?.type,
      model: last?.model,
      online: last?.state === 1,
      firmware: last?.data?.firmware || null,
      upgradable: Boolean(last?.data?.upgradable),
      latest: last
        ? {
            ts: last.ts,
            cpu: last.cpu,
            mem: last.mem,
            temp: last.temp,
            temps: last.data.temps || [],
            uptime: last.uptime,
            clients: last.clients,
            radios: (last.data.radios || []).map((r) => ({ ...r, band: bandName(r.radio) })),
            ports: last.data.ports || [],
            uplink: last.data.uplink || null,
          }
        : null,
      peak: {
        cpu: list.length ? Math.max(...list.map((r) => r.cpu ?? 0)) : null,
        mem: list.length ? Math.max(...list.map((r) => r.mem ?? 0)) : null,
        temp: list.some((r) => r.temp != null) ? Math.max(...list.map((r) => r.temp ?? -Infinity)) : null,
      },
      series: bucketsOf(list, start, end, (g) => {
        const out = { cpu: avg(g.map((r) => r.cpu)), mem: avg(g.map((r) => r.mem)), temp: avg(g.map((r) => r.temp)), clients: avg(g.map((r) => r.clients)) };
        for (const radio of radios) out[`util_${radio}`] = avg(g.map((r) => (r.data.radios || []).find((x) => x.radio === radio)?.util));
        return out;
      }),
      radios: radios.map((r) => ({ radio: r, band: bandName(r) })),
    };
  });
  const order = { udm: 0, ugw: 0, uxg: 0, usw: 1, uap: 2 };
  devices.sort((a, b) => (order[a.type] ?? 3) - (order[b.type] ?? 3) || String(a.name).localeCompare(String(b.name)));
  return { devices, step: stepFor(start, end), samples: rows.length };
}

// ---- access points on one channel (UU-C-198) --------------------------------------------

const AIR_BAND = { ng: "2.4", na: "5", "6e": "6", "11be": "6" };

// The stretch of channel numbers a radio occupies. UniFi reports the primary channel, so a wide
// radio is found from the block it sits in. With no width recorded (samples from before UU-C-198)
// only the channel itself counts, which can miss an overlap but never invents one.
export function channelSpan(radio, channel, width) {
  const band = AIR_BAND[radio];
  if (!band || !channel) return null;
  if (band === "2.4") {
    const half = width >= 40 ? 6 : 2;
    return [channel - half, channel + half];
  }
  if (!width) return [channel, channel];
  const base = band === "6" ? 1 : channel >= 149 ? 149 : channel >= 100 ? 100 : 36;
  const step = width / 5;
  const lo = base + Math.floor((channel - base) / step) * step;
  return [lo, lo + step - 1];
}

// A mesh access point has to use its parent's channel, so that is not something to fix. An old
// sample has no flag: an uplink with no port is the wireless one.
const onMesh = (d) => (d.data?.uplink ? (d.data.uplink.wireless ?? d.data.uplink.port == null) : false);

// Pairs of access points whose radios overlapped, and for how long, in [start, end).
export function channelOverlaps(start, end) {
  const byTs = new Map();
  for (const r of db.queryDeviceSamples(start, end)) {
    if (r.type !== "uap" || r.state !== 1 || onMesh(r)) continue;
    const list = byTs.get(r.ts);
    if (list) list.push(r);
    else byTs.set(r.ts, [r]);
  }
  const times = [...byTs.keys()].sort((a, b) => a - b);
  const pairs = new Map();
  times.forEach((ts, i) => {
    // Time until the next sample; a long gap (NetLens was off) is not time on the channel.
    const ms = Math.min((times[i + 1] ?? ts + SAMPLE_MIN * 60e3) - ts, 15 * 60e3);
    const aps = byTs.get(ts).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    for (let x = 0; x < aps.length; x += 1) {
      for (let y = x + 1; y < aps.length; y += 1) {
        for (const ra of aps[x].data.radios || []) {
          const rb = (aps[y].data.radios || []).find((o) => AIR_BAND[o.radio] && AIR_BAND[o.radio] === AIR_BAND[ra.radio]);
          const sa = rb && channelSpan(ra.radio, ra.channel, ra.width);
          const sb = rb && channelSpan(rb.radio, rb.channel, rb.width);
          if (!sa || !sb || sa[1] < sb[0] || sb[1] < sa[0]) continue;
          const key = `${aps[x].mac}-${aps[y].mac}-${AIR_BAND[ra.radio]}`;
          const p = pairs.get(key) || { key, band: AIR_BAND[ra.radio], ms: 0, clientsA: 0, clientsB: 0, n: 0 };
          p.ms += ms;
          p.n += 1;
          p.clientsA += ra.clients || 0;
          p.clientsB += rb.clients || 0;
          Object.assign(p, { ts, a: { mac: aps[x].mac, name: aps[x].name, channel: ra.channel }, b: { mac: aps[y].mac, name: aps[y].name, channel: rb.channel } });
          pairs.set(key, p);
        }
      }
    }
  });
  const last = times[times.length - 1];
  return [...pairs.values()].map((p) => ({ ...p, current: p.ts === last }));
}

// ---- one device's history (UU-C-198) ------------------------------------------------------
// NetLens' own record of what UniFi's Time Machine shows, which has no public API: a radio's
// load and channel, a port's link and errors. SQLite only, like everything in this file.

const linkText = (mbps) => (mbps >= 1000 ? `${+(mbps / 1000).toFixed(1)} Gbps` : `${mbps} Mbps`);
const HISTORY_EVENTS = 60;

// Bytes through a port between two samples (UU-C-233). The counters are running totals that
// start over when the device restarts: a smaller value than before is what came since the
// restart. Samples without counters (before UU-C-233) give nothing.
export function portDelta(was, x) {
  if (!was || x.rxBytes == null || x.txBytes == null || was.rxBytes == null || was.txBytes == null) return null;
  return {
    fromDevice: x.rxBytes >= was.rxBytes ? x.rxBytes - was.rxBytes : x.rxBytes,
    toDevice: x.txBytes >= was.txBytes ? x.txBytes - was.txBytes : x.txBytes,
  };
}

// Traffic per port of one device in (from, to], from its samples (UU-C-233).
export function portTrafficOf(mac, from, to) {
  const rows = db.queryDeviceSamplesOf(mac, from - 30 * 60 * 1000, to + 1);
  const out = new Map();
  let prev = null;
  for (const r of rows) {
    if (prev && r.ts > from) {
      const before = new Map((prev.data.ports || []).map((x) => [x.idx, x]));
      for (const x of r.data.ports || []) {
        const d = portDelta(before.get(x.idx), x);
        if (!d) continue;
        const t = out.get(x.idx) || { toDevice: 0, fromDevice: 0 };
        t.toDevice += d.toDevice;
        t.fromDevice += d.fromDevice;
        out.set(x.idx, t);
      }
    }
    prev = r;
  }
  return out;
}

// ---- Who is on each port, and where each device was (UU-C-248) ----------------------------
// A port starts over when a different device takes it: its busiest 5 minutes, drops and notes
// count from then. A device's own record follows its MAC wherever it is plugged in. A change
// counts once the new one held for 3 updates (15 minutes), so the overlap while a cable moves
// (UniFi can list both for an update) is not a change.
const STEADY = 3;
export function steadyChanges(seq, accept = () => true) {
  // seq: [{ ts, key }] in time order (key null = nothing there, skipped). `accept(ts, key)` can
  // refuse a change (the "new" one was there all along).
  const changes = [];
  let cur = null;
  let cand = null;
  let count = 0;
  let candTs = null;
  for (const { ts, key } of seq) {
    if (key == null) continue;
    if (key === cur) {
      cand = null;
      count = 0;
      continue;
    }
    if (key === cand) count += 1;
    else {
      cand = key;
      count = 1;
      candTs = ts;
    }
    if (count >= STEADY) {
      if (cur != null && !accept(candTs, cand)) {
        cand = null;
        count = 0;
        continue;
      }
      if (cur != null) changes.push({ ts: candTs, from: cur, to: cand });
      cur = cand;
      cand = null;
      count = 0;
    }
  }
  return { current: cur, changes };
}

// Per port of a switch or gateway: the device on it now (MAC), since when (null = before the
// window) and each change. Equipment on a port wins; else the client connected longest (a server,
// not its containers, which come and go).
export function portOccupancy(apMac, from, to) {
  const name = db.latestDeviceSamples().find((d) => d.mac === apMac)?.name;
  const byTs = new Map();
  const put = (ts, port, mac, rank) => {
    const k = `${ts}|${port}`;
    const best = byTs.get(k);
    if (!best || rank > best.rank) byTs.set(k, { ts, port, mac, rank });
  };
  for (const r of db.wiredSamplesOn(apMac, from, to)) put(r.ts, r.port, r.mac, r.uptime ?? 0);
  if (name) for (const r of db.uplinksTo(name, from, to)) if (r.port != null) put(r.ts, r.port, r.mac, Number.MAX_SAFE_INTEGER);
  // When each MAC was first seen on each port in the window: a device that takes over a port is
  // new there; a server's VM or container that briefly outranks it was there all along.
  const firstSeen = new Map();
  const seen = (port, mac, ts) => {
    const k = `${port}|${mac}`;
    if (!firstSeen.has(k) || ts < firstSeen.get(k)) firstSeen.set(k, ts);
  };
  for (const r of db.wiredSamplesOn(apMac, from, to)) seen(r.port, r.mac, r.ts);
  if (name) for (const r of db.uplinksTo(name, from, to)) if (r.port != null) seen(r.port, r.mac, r.ts);
  const perPort = new Map();
  for (const v of [...byTs.values()].sort((a, b) => a.ts - b.ts)) {
    const list = perPort.get(v.port) || [];
    list.push({ ts: v.ts, key: v.mac });
    perPort.set(v.port, list);
  }
  const out = new Map();
  for (const [port, seq] of perPort) {
    const { current, changes } = steadyChanges(seq, (ts, mac) => (firstSeen.get(`${port}|${mac}`) ?? 0) >= ts - 10 * 60e3);
    out.set(Number(port), { current, since: changes.length ? changes[changes.length - 1].ts : null, changes });
  }
  return out;
}

// The network (VLAN) an address belongs to, from UniFi's network list (setting `networks`, read
// hourly); without it, the /24 the address is in.
const ipNum = (ip) => String(ip).split(".").reduce((n, x) => n * 256 + Number(x), 0);
export function networkOfIp(ip) {
  if (!ip || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return null;
  let nets = [];
  try {
    nets = JSON.parse(db.getSetting("networks", "[]")) || [];
  } catch {
    nets = [];
  }
  for (const n of nets) {
    const [base, bits] = String(n.subnet).split("/");
    const mask = Number(bits) ? (0xffffffff << (32 - Number(bits))) >>> 0 : 0;
    if (((ipNum(ip) & mask) >>> 0) === ((ipNum(base) & mask) >>> 0)) return { name: n.name, vlan: n.vlan };
  }
  return { name: `${ip.split(".").slice(0, 3).join(".")}.x`, vlan: null };
}

// A device's places from its readings [{ ts, apMac, port, ip }] in time order (UU-C-248): a port
// change counts once it held 3 updates (a stale reading during a move is not one); within a port,
// every change of network counts, however short (a port briefly on the wrong VLAN is the thing
// to see). Each stretch: switch / gateway MAC, port, network, from, to, the address it last had.
export function placeStretches(rows) {
  const placed = rows.filter((r) => r.apMac && r.port != null);
  if (!placed.length) return [];
  const portKey = (r) => `${r.apMac}|${r.port}`;
  const { changes } = steadyChanges(placed.map((r) => ({ ts: r.ts, key: portKey(r) })));
  const first = changes.length ? changes[0].from : portKey(placed[0]);
  const portRuns = [{ key: first, from: placed[0].ts }, ...changes.map((c) => ({ key: c.to, from: c.ts }))];
  const out = [];
  portRuns.forEach((run, i) => {
    const until = portRuns[i + 1]?.from ?? Infinity;
    const [apMac, port] = run.key.split("|");
    // Readings on this port in the run; other ports' stray readings inside it are left out.
    const mine = placed.filter((r) => r.ts >= run.from && r.ts < until && portKey(r) === run.key);
    let cur = null;
    for (const r of mine) {
      const net = networkOfIp(r.ip)?.name || null;
      if (!cur || (net && cur.network && net !== cur.network)) {
        if (cur) cur.to = r.ts;
        cur = { apMac, port: Number(port), network: net, from: cur ? r.ts : run.from, to: r.ts, ip: r.ip || null };
        out.push(cur);
      } else {
        cur.to = r.ts;
        if (r.ip) cur.ip = r.ip;
        if (!cur.network && net) cur.network = net;
      }
    }
    if (cur && Number.isFinite(until)) cur.to = until;
  });
  return out;
}

// Where one wired device was plugged in, newest first (the Device page, UU-C-248).
export function wiredPlaces(mac, from, to) {
  const nameOf = names();
  const list = placeStretches(db.wiredPlacesOf(mac, from, to));
  return list
    .map((p, i) => ({ ...p, via: nameOf(p.apMac), vlan: networkOfIp(p.ip)?.vlan ?? null, current: i === list.length - 1 }))
    .reverse();
}

// Packets dropped and carried per port between two samples (UU-C-245). Running totals that start
// over when the device restarts, like the bytes; a sample without them gives nothing.
const DROP_KEYS = ["txDropped", "rxDropped", "txPackets", "rxPackets"];
export function dropDelta(was, x) {
  if (!was || DROP_KEYS.some((k) => x[k] == null || was[k] == null)) return null;
  const d = {};
  for (const k of DROP_KEYS) d[k] = x[k] >= was[k] ? x[k] - was[k] : x[k];
  return d;
}

// Drops per port of one device in (from, to]: toDevice = sent out of the port to the device on it
// (tx), fromDevice = received from it (rx); packets the same way, for a share.
export function portDrops(mac, from, to) {
  const rows = db.queryDeviceSamplesOf(mac, from - 30 * 60 * 1000, to + 1);
  const out = new Map();
  let prev = null;
  for (const r of rows) {
    if (prev && r.ts > from) {
      const before = new Map((prev.data.ports || []).map((x) => [x.idx, x]));
      for (const x of r.data.ports || []) {
        const d = dropDelta(before.get(x.idx), x);
        if (!d) continue;
        const t = out.get(x.idx) || { toDevice: 0, fromDevice: 0, toPackets: 0, fromPackets: 0 };
        t.toDevice += d.txDropped;
        t.fromDevice += d.rxDropped;
        t.toPackets += d.txPackets;
        t.fromPackets += d.rxPackets;
        out.set(x.idx, t);
      }
    }
    prev = r;
  }
  return out;
}
// Share of packets dropped, the worse direction (a port drops on the way out, toward a slower link).
export const dropShare = (d) => Math.max(d.toPackets ? d.toDevice / (d.toPackets + d.toDevice) : 0, d.fromPackets ? d.fromDevice / (d.fromPackets + d.fromDevice) : 0);

// Each port's busiest stretch between two samples in (from, to] (UU-C-239): the faster of the two
// directions (a link carries its full speed each way), as bits/s and as a share of the link.
// Samples are 5 minutes apart, so this is the busiest 5 minutes, not the briefest burst. A gap
// of over 20 minutes (NetLens was off) is left out: its average says nothing about a peak.
export function portPeaks(mac, from, to) {
  const rows = db.queryDeviceSamplesOf(mac, from - 30 * 60 * 1000, to + 1);
  const out = new Map();
  let prev = null;
  for (const r of rows) {
    const secs = prev ? (r.ts - prev.ts) / 1000 : 0;
    if (prev && r.ts > from && secs > 0 && secs <= 1200) {
      const before = new Map((prev.data.ports || []).map((x) => [x.idx, x]));
      for (const x of r.data.ports || []) {
        const d = portDelta(before.get(x.idx), x);
        if (!d) continue;
        const toBps = (d.toDevice * 8) / secs;
        const fromBps = (d.fromDevice * 8) / secs;
        const bps = Math.max(toBps, fromBps);
        const share = x.speed ? bps / (x.speed * 1e6) : null;
        const best = out.get(x.idx);
        if (!best || (share ?? bps / 1e12) > (best.share ?? best.bps / 1e12)) {
          out.set(x.idx, { bps: Math.round(bps), dir: toBps >= fromBps ? "toDevice" : "fromDevice", from: prev.ts, at: r.ts, speed: x.speed || null, share: share == null ? null : Math.min(1, share), wan: x.wan === true, uplink: x.uplink === true });
        }
      }
    }
    prev = r;
  }
  return out;
}

// The last 15 minutes per port, up to t (UU-C-233): from the newest sample back to the newest one
// at least 15 minutes older, scaled to 15 minutes (the update interval can be longer than that).
// Nothing when the newest sample is over an hour old.
export function portRecentOf(mac, t) {
  const rows = db.queryDeviceSamplesOf(mac, t - 3 * 3600e3, t + 1);
  const latest = rows.at(-1);
  if (!latest || t - latest.ts > 3600e3) return new Map();
  let k = rows.length - 2;
  while (k >= 0 && rows[k].ts > latest.ts - 15 * 60 * 1000) k -= 1;
  if (k < 0) return new Map();
  const moved = portTrafficOf(mac, rows[k].ts, latest.ts);
  const scale = (15 * 60 * 1000) / (latest.ts - rows[k].ts);
  return new Map([...moved].map(([idx, m]) => [idx, { toDevice: Math.round(m.toDevice * scale), fromDevice: Math.round(m.fromDevice * scale) }]));
}

export function deviceHistory(mac, days, now) {
  const start = now - days * 24 * 3600e3;
  const rows = db.queryDeviceSamplesOf(mac, start, now + 1);
  const step = days <= 1 ? 1800e3 : days <= 7 ? 4 * 3600e3 : days <= 30 ? 12 * 3600e3 : 24 * 3600e3;
  const count = Math.ceil((now - start) / step);
  const events = [];
  const radios = new Map();
  const ports = new Map();
  let prev = null;
  for (const r of rows) {
    if (prev && prev.state === 1 && r.state !== 1) events.push({ ts: r.ts, level: "bad", what: "Went offline" });
    else if (prev && prev.state !== 1 && r.state === 1) events.push({ ts: r.ts, level: "ok", what: "Back online" });
    // Timed from its uptime: the first sample after a restart can be hours later if NetLens was off.
    else if (prev && r.uptime != null && prev.uptime != null && r.uptime < prev.uptime) events.push({ ts: Math.max(prev.ts, r.ts - r.uptime * 1000), level: "warn", what: "Restarted" });
    // Firmware changes (UU-C-229); a gateway's firmware is its UniFi OS.
    // Compared on the full version (every sample has it); shown as UniFi shows it.
    const shown = (x) => x?.data?.version || x?.data?.firmware;
    if (prev?.data?.firmware && r.data?.firmware && prev.data.firmware !== r.data.firmware) events.push({ ts: r.ts, level: "info", what: `${/udm|ugw|uxg/.test(r.type || "") ? "UniFi OS" : "Firmware"} updated to ${shown(r)}`, detail: `from ${prev.data.version || prev.data.firmware}` });
    const slot = Math.min(count - 1, Math.floor((r.ts - start) / step));
    for (const x of r.data.radios || []) {
      const h = radios.get(x.radio) || { radio: x.radio, band: bandName(x.radio), slots: Array.from({ length: count }, () => []), last: null };
      h.slots[slot].push(x);
      if (h.last?.channel != null && x.channel != null && h.last.channel !== x.channel) events.push({ ts: r.ts, level: "info", what: `${h.band} moved to channel ${x.channel}`, detail: `from channel ${h.last.channel}` });
      else if (h.last?.width && x.width && h.last.width !== x.width) events.push({ ts: r.ts, level: "info", what: `${h.band} width changed to ${x.width} MHz`, detail: `from ${h.last.width} MHz` });
      h.last = x;
      radios.set(x.radio, h);
    }
    for (const x of r.data.ports || []) {
      const p = ports.get(x.idx) || { idx: x.idx, name: x.name || null, errors: 0, poePeak: null, changes: 0, last: null, lastTs: null, toDevice: null, fromDevice: null, peakBps: null, drops: null };
      const was = p.last;
      // Packets dropped (UU-C-245).
      const dd = dropDelta(was, x);
      if (dd) {
        const t = p.drops || { toDevice: 0, fromDevice: 0, toPackets: 0, fromPackets: 0 };
        t.toDevice += dd.txDropped;
        t.fromDevice += dd.rxDropped;
        t.toPackets += dd.txPackets;
        t.fromPackets += dd.rxPackets;
        p.drops = t;
      }
      // Traffic (UU-C-233), and the busiest stretch between two samples as a rate.
      const moved = portDelta(was, x);
      if (moved) {
        p.toDevice = (p.toDevice || 0) + moved.toDevice;
        p.fromDevice = (p.fromDevice || 0) + moved.fromDevice;
        const secs = (r.ts - p.lastTs) / 1000;
        if (secs > 0) p.peakBps = Math.max(p.peakBps || 0, ((moved.toDevice + moved.fromDevice) * 8) / secs);
      }
      p.lastTs = r.ts;
      // "Port 5" adds nothing after "Port 5 went down"; a name someone gave it does.
      const own = x.name && x.name !== `Port ${x.idx}` ? x.name : null;
      if (was && Boolean(was.up) !== Boolean(x.up)) {
        p.changes += 1;
        events.push(x.up ? { ts: r.ts, port: x.idx, level: "info", what: `Port ${x.idx} came up`, detail: [own, x.speed ? linkText(x.speed) : null].filter(Boolean).join(" · ") } : { ts: r.ts, port: x.idx, level: "warn", what: `Port ${x.idx} went down`, detail: own || "" });
      } else if (was && x.up && was.speed && x.speed && was.speed !== x.speed) {
        p.changes += 1;
        events.push({ ts: r.ts, port: x.idx, level: x.speed < was.speed ? "warn" : "info", what: `Port ${x.idx} changed to ${linkText(x.speed)}`, detail: [own, `from ${linkText(was.speed)}`].filter(Boolean).join(" · ") });
      }
      // The counters are running totals that restart with the device: only rises count.
      if (was) p.errors += Math.max(0, (x.rxErrors || 0) + (x.txErrors || 0) - (was.rxErrors || 0) - (was.txErrors || 0));
      if (x.poe != null) p.poePeak = Math.max(p.poePeak ?? 0, x.poe);
      p.name = x.name || p.name;
      if (x.wan) p.wan = true; // the internet port reads from your side in the table (UU-C-252)
      p.last = x;
      ports.set(x.idx, p);
    }
    prev = r;
  }
  // A different device on a port (UU-C-248): said as such, and the port's speed change around it
  // is that device's speed, not a slowdown.
  if (rows.some((r) => (r.data.ports || []).length)) {
    const nameOf = names();
    const occ = portOccupancy(mac, start - 2 * 3600e3, now + 1);
    const swaps = [];
    for (const [port, o] of occ) for (const c of o.changes) if (c.ts >= start) swaps.push({ port, ...c });
    for (const s of swaps) events.push({ ts: s.ts, level: "info", what: `Port ${s.port}: ${nameOf(s.to)} connected`, detail: `was ${nameOf(s.from)}` });
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i];
      if (e.port != null && swaps.some((s) => s.port === e.port && Math.abs(s.ts - e.ts) <= 20 * 60e3)) events.splice(i, 1);
    }
  }
  for (const e of events) delete e.port;
  const bandOrder = { ng: 0, na: 1 };
  events.sort((a, b) => b.ts - a.ts);
  return {
    mac,
    days,
    start,
    end: now,
    step,
    samples: rows.length,
    radios: [...radios.values()]
      .sort((a, b) => (bandOrder[a.radio] ?? 2) - (bandOrder[b.radio] ?? 2))
      .map((h) => {
        const all = h.slots.flat();
        return {
          radio: h.radio,
          band: h.band,
          channel: h.last?.channel ?? null,
          width: h.last?.width ?? null,
          avgUtil: avg(all.map((x) => x.util)),
          peakUtil: all.length ? Math.max(...all.map((x) => x.util ?? 0)) : null,
          series: h.slots.map((g, i) => ({
            t: start + i * step,
            util: g.length ? avg(g.map((x) => x.util)) : null,
            peak: g.length ? Math.max(...g.map((x) => x.util ?? 0)) : null,
            clients: g.length ? avg(g.map((x) => x.clients)) : null,
            channel: g.length ? g[g.length - 1].channel : null,
          })),
        };
      }),
    ports: [...ports.values()]
      .filter((p) => p.errors > 0 || p.changes > 0 || p.poePeak > 0 || (p.toDevice || 0) + (p.fromDevice || 0) > 0 || (p.drops && p.drops.toDevice + p.drops.fromDevice > 0))
      .map(({ last, lastTs, drops, ...p }) => ({ ...p, dropped: drops ? drops.toDevice + drops.fromDevice : null, dropShare: drops ? dropShare(drops) : null, droppedTo: drops?.toDevice ?? null, droppedFrom: drops?.fromDevice ?? null }))
      .sort((a, b) => a.idx - b.idx),
    events: events.slice(0, HISTORY_EVENTS),
    moreEvents: Math.max(0, events.length - HISTORY_EVENTS),
  };
}

// The whole network over time (UU-C-213): the internet line (speed, latency, outages, public
// IP), how many devices were on, and one list of what changed on the switches, access points
// and gateway (each one's deviceHistory), plus devices UniFi first saw in the period.
export function networkTimeline(days, now) {
  const start = now - days * 24 * 3600e3;
  const step = days <= 1 ? 1800e3 : days <= 7 ? 4 * 3600e3 : days <= 30 ? 12 * 3600e3 : 24 * 3600e3;
  const count = Math.ceil((now - start) / step);
  const slot = (ts) => Math.min(count - 1, Math.max(0, Math.floor((ts - start) / step)));
  const slots = Array.from({ length: count }, () => ({ down: [], up: [], latency: [], devices: [], wired: [], bad: 0 }));
  const events = [];
  const wan = db.wanSamplesIn(start, now + 1);
  let prev = null;
  for (const w of wan) {
    const g = slots[slot(w.ts)];
    if (w.rxRate != null) g.down.push(w.rxRate);
    if (w.txRate != null) g.up.push(w.txRate);
    if (w.latency != null) g.latency.push(w.latency);
    const ok = !w.status || w.status === "ok";
    if (!ok) g.bad += 1;
    if (prev) {
      const wasOk = !prev.status || prev.status === "ok";
      if (wasOk && !ok) events.push({ ts: w.ts, level: "bad", who: "Internet", what: `Internet ${w.status}` });
      else if (!wasOk && ok) events.push({ ts: w.ts, level: "ok", who: "Internet", what: "Internet back" });
      if (w.ip && prev.ip && w.ip !== prev.ip) events.push({ ts: w.ts, level: "info", who: "Internet", what: `Public IP changed to ${w.ip}`, detail: `from ${prev.ip}` });
    }
    prev = w;
  }
  for (const c of db.clientCountsIn(start, now + 1)) {
    const g = slots[slot(c.ts)];
    g.devices.push(c.n);
    g.wired.push(c.wired || 0);
  }
  const nameOf = names();
  let more = 0;
  for (const mac of db.deviceMacsIn(start, now + 1)) {
    const h = deviceHistory(mac, days, now);
    const who = nameOf(mac);
    for (const e of h.events) events.push({ ...e, who });
    more += h.moreEvents || 0;
  }
  for (const c of db.listStoredClients()) {
    if (c.firstSeen && c.firstSeen >= start && c.firstSeen <= now) events.push({ ts: c.firstSeen, level: "info", who: nameOf(c.mac), mac: c.mac, what: "New device", detail: c.vendor || "" });
  }
  events.sort((a, b) => b.ts - a.ts);
  const LIMIT = 120;
  const mbps = (bytesPerSec) => (bytesPerSec == null ? null : Math.round((bytesPerSec * 8) / 1e5) / 10);
  const series = slots.map((g, i) => {
    const devices = avg(g.devices);
    const wired = avg(g.wired);
    return {
      t: start + i * step,
      down: g.down.length ? mbps(avg(g.down)) : null,
      downPeak: g.down.length ? mbps(Math.max(...g.down)) : null,
      up: g.up.length ? mbps(avg(g.up)) : null,
      latency: g.latency.length ? avg(g.latency) : null,
      devices: devices == null ? null : Math.round(devices),
      wired: wired == null ? null : Math.round(wired),
      wifi: devices == null ? null : Math.round(devices - (wired || 0)),
      outage: g.bad > 0,
    };
  });
  const seen = series.filter((s) => s.devices != null);
  return {
    days,
    start,
    end: now,
    step,
    samples: wan.length + seen.length,
    series,
    summary: {
      latency: avg(wan.map((w) => w.latency).filter((x) => x != null)),
      downPeak: wan.length ? mbps(wan.reduce((m, w) => Math.max(m, w.rxRate || 0), 0)) : null,
      upPeak: wan.length ? mbps(wan.reduce((m, w) => Math.max(m, w.txRate || 0), 0)) : null,
      devicesPeak: seen.length ? Math.max(...seen.map((s) => s.devices)) : null,
      outages: events.filter((e) => e.who === "Internet" && e.level === "bad").length,
    },
    events: events.slice(0, LIMIT),
    moreEvents: Math.max(0, events.length - LIMIT) + more,
  };
}

// ---- Wi-Fi quality --------------------------------------------------------------------

function roamsFor(start, end, mac) {
  return db
    .querySiemEvents(start, end, mac || null)
    .filter((e) => e.kind === "log" && /ROAMED/.test(e.data?.key || ""))
    .map((e) => ({ ts: e.ts, mac: e.mac, msg: e.data?.msg || null, via: e.data?.via || null }));
}

// ---- connection history from UniFi's System Log (UU-C-102) ------------------------------
// Connects, roams and disconnects name the access point (with signal, band, channel) or the
// switch and port. They are moments, not a running record, so samples win where they exist.

const durationMs = (txt) => {
  let ms = 0;
  for (const [, n, u] of String(txt || "").matchAll(/(\d+)\s*([dhms])/g)) ms += Number(n) * { d: 864e5, h: 36e5, m: 6e4, s: 1e3 }[u];
  return ms || null;
};

function parseLinkEvent(e) {
  const d = e.data || {};
  const p = d.params || {};
  const key = d.key || "";
  const msg = d.msg || "";
  const kind = /ROAMED/.test(key) ? "roam" : /DISCONNECTED/.test(key) ? "disconnect" : "connect";
  const connectedMs = kind === "disconnect" ? durationMs(d.duration) : null;
  if (/WIRED/.test(key)) {
    const port = /Port (\d+)/.exec(p.DEVICE_WITH_PORT?.n || d.via || "");
    const via = p.DEVICE?.n || (d.via || "").replace(/ Port \d+$/, "") || null;
    return { ts: e.ts, mac: e.mac, kind, wired: true, via, port: port ? Number(port[1]) : null, ip: d.clientIp || null, connectedMs };
  }
  const band = /\(([\d.]+) GHz/.exec(msg);
  const essid = /\bconnected to (.+?) on /.exec(msg);
  const signal = Number(p.SIGNAL_STRENGTH?.n ?? d.signal);
  return {
    ts: e.ts,
    mac: e.mac,
    kind,
    wired: false,
    via: p.DEVICE_TO?.n || (d.via || "").split(" → ").pop() || null,
    signal: Number.isFinite(signal) && signal < 0 ? signal : null,
    band: band ? `${band[1]} GHz` : null,
    channel: p.CHANNEL?.n ? Number(p.CHANNEL.n) : null,
    ip: d.clientIp || null,
    essid: essid ? essid[1] : null, //  keeps "disconnected from" out
    connectedMs,
  };
}

// Per device for [start, end): the day's events, the last event at or before the day (up to
// 30 days back — where it already was at midnight), and segments of time on each AP / port.
export function logHistory(start, end, mac = null, now = Date.now()) {
  const events = db.linkEvents(start - 30 * 86400e3, end, mac ? String(mac).toLowerCase() : null).map(parseLinkEvent);
  // Disconnects carry the channel but not the band; take it from that AP and channel elsewhere.
  const bandAt = new Map();
  for (const e of events) if (e.band && e.channel) bandAt.set(`${e.via}|${e.channel}`, e.band);
  const byMac = new Map();
  for (const e of events) {
    if (!e.wired && !e.band && e.channel) e.band = bandAt.get(`${e.via}|${e.channel}`) || (e.channel <= 14 ? "2.4 GHz" : null);
    const list = byMac.get(e.mac);
    if (list) list.push(e);
    else byMac.set(e.mac, [e]);
  }
  const stop = Math.min(end, now);
  const out = new Map();
  for (const [m, list] of byMac) {
    const inDay = list.filter((e) => e.ts >= start);
    const prior = list.filter((e) => e.ts < start).pop() || null;
    const segments = [];
    let open = null;
    const close = (t) => {
      if (open && t > open.from) segments.push({ ...open, to: t });
      open = null;
    };
    const seg = (from, e) => ({ from, via: e.via, port: e.port ?? null, band: e.band ?? null });
    if (prior && prior.kind !== "disconnect") open = seg(start, prior);
    for (const e of inDay) {
      if (e.kind === "disconnect") {
        // "Time Connected" dates the start of a session whose connect fell outside the log.
        if (!open && e.connectedMs) open = seg(Math.max(start, e.ts - e.connectedMs), e);
        close(e.ts);
      } else {
        close(e.ts);
        open = seg(e.ts, e);
      }
    }
    close(stop);
    const known = [...(prior ? [prior] : []), ...inDay];
    const last = known[known.length - 1] || null;
    const lastWith = (k) => [...known].reverse().find((e) => e[k] != null)?.[k] ?? null;
    out.set(m, {
      last,
      events: inDay,
      segments,
      link: last && {
        wired: last.wired,
        via: last.via,
        port: last.wired ? last.port : undefined,
        signal: last.wired ? undefined : lastWith("signal"),
        band: last.wired ? undefined : last.band,
        channel: last.wired ? undefined : last.channel,
        essid: last.wired ? undefined : lastWith("essid"),
        aps: [...new Set(segments.map((s) => s.via).filter(Boolean))],
        // The address it had that day; an earlier one only as a fallback (UU-C-104).
        ip: [...inDay].reverse().find((e) => e.ip)?.ip || null,
        priorIp: prior?.ip || null,
        logged: last.ts,
      },
    });
  }
  return out;
}

// `samples`: the period's client samples when the caller already has them (UU-C-217).
export function wifiList(start, end, samples = null) {
  const nameOf = names();
  const rows = (samples || db.queryClientSamples(start, end, null)).filter((r) => !r.wired);
  const roams = roamsFor(start, end, null);
  const roamCount = new Map();
  for (const r of roams) roamCount.set(r.mac, (roamCount.get(r.mac) || 0) + 1);
  const byMac = new Map();
  for (const r of rows) {
    const list = byMac.get(r.mac);
    if (list) list.push(r);
    else byMac.set(r.mac, [r]);
  }
  const clients = [...byMac.entries()].map(([mac, list]) => {
    const last = list[list.length - 1];
    const sig = list.map((r) => r.signal).filter((s) => s != null);
    return {
      mac,
      name: nameOf(mac),
      ap: nameOf(last.ap_mac),
      band: bandName(last.radio),
      channel: last.channel,
      signal: last.signal,
      lastSeen: last.ts,
      avgSignal: avg(sig),
      weakShare: sig.length ? Math.round((sig.filter((s) => s < WEAK).length / sig.length) * 100) : null,
      badShare: sig.length ? Math.round((sig.filter((s) => s < BAD).length / sig.length) * 100) : null,
      satisfaction: avg(list.map((r) => r.satisfaction)),
      roams: roamCount.get(mac) || 0,
      minutes: list.length * SAMPLE_MIN,
    };
  });
  clients.sort((a, b) => (b.badShare ?? -1) - (a.badShare ?? -1) || (a.avgSignal ?? 0) - (b.avgSignal ?? 0));
  return { clients, thresholds: { weak: WEAK, bad: BAD } };
}

// Wired devices (UU-C-078): the same 5-minute samples, wired = 1. Which switch and port,
// link speed now and the slowest seen (a cable or port renegotiating down shows up here),
// how often the speed changed, and how long the device was connected.
// The highest value that held for at least `runs` samples in a row; with no such run (a short
// period), the highest of the longest runs.
export function steadyTop(values, runs = 3) {
  const seq = [];
  for (const v of values) {
    if (v == null) continue;
    const last = seq[seq.length - 1];
    if (last && last.v === v) last.n += 1;
    else seq.push({ v, n: 1 });
  }
  if (!seq.length) return null;
  const steady = seq.filter((s) => s.n >= runs);
  if (steady.length) return Math.max(...steady.map((s) => s.v));
  const longest = Math.max(...seq.map((s) => s.n));
  return Math.max(...seq.filter((s) => s.n === longest).map((s) => s.v));
}

export function wiredList(start, end, samples = null) {
  const nameOf = names();
  const byMac = new Map();
  for (const r of samples || db.queryClientSamples(start, end, null)) {
    if (!r.wired) continue;
    const list = byMac.get(r.mac);
    if (list) list.push(r);
    else byMac.set(r.mac, [r]);
  }
  const mbps = (r) => (r.tx_rate != null ? Math.round(r.tx_rate / 1000) : null);
  const clients = [...byMac.entries()].map(([mac, list]) => {
    const last = list[list.length - 1];
    const speeds = list.map(mbps).filter((v) => v != null);
    let changes = 0;
    for (let i = 1; i < list.length; i += 1) if (mbps(list[i]) != null && mbps(list[i - 1]) != null && mbps(list[i]) !== mbps(list[i - 1])) changes += 1;
    // Stretches below the device's top speed (UU-C-125): a sleeping PC drops its link to
    // 10 Mbps on purpose (Wake-on-LAN), so the caller compares them with traffic.
    // A speed counts as the device's top only when it held for 3 updates in a row (UU-C-247): while
    // a cable moves between ports UniFi can report the device at the previous device's speed for
    // one update (the TV read 2.5 Gbps once on the U7 Pro's old port), and a 100 Mbps device then
    // looked like it had dropped from 2.5 Gbps.
    const top = steadyTop(list.map(mbps));
    const lowSpans = [];
    for (let i = 0; i < list.length; i += 1) {
      const v = mbps(list[i]);
      if (v == null || top == null || v >= top) continue;
      const cur = lowSpans[lowSpans.length - 1];
      if (cur && cur.lastIdx === i - 1) {
        cur.lastIdx = i;
        cur.speed = Math.min(cur.speed, v);
      } else lowSpans.push({ from: list[i].ts, lastIdx: i, speed: v });
    }
    for (const sp of lowSpans) {
      sp.to = list[sp.lastIdx + 1]?.ts ?? Math.min(end, list[sp.lastIdx].ts + SAMPLE_MIN * 60e3);
      sp.recovered = Boolean(list[sp.lastIdx + 1]);
      delete sp.lastIdx;
    }
    return {
      topSpeed: top,
      lowSpans,
      mac,
      name: nameOf(mac),
      switch: last.ap_mac ? nameOf(last.ap_mac) : null,
      port: last.port ?? null,
      speed: mbps(last),
      minSpeed: speeds.length ? Math.min(...speeds) : null,
      speedChanges: changes,
      lastSeen: last.ts,
      minutes: list.length * SAMPLE_MIN,
      // UniFi's own connection time at the last sample, not how long NetLens has watched.
      uptime: last.uptime ?? null,
    };
  });
  // Slow links first (a gigabit device stuck at 100 Mbps is the thing worth seeing), then by name.
  clients.sort((a, b) => (a.minSpeed ?? 1e9) - (b.minSpeed ?? 1e9) || String(a.name).localeCompare(String(b.name)));
  return { clients };
}

export function wifiClient(start, end, mac, tz) {
  const nameOf = names();
  const m = String(mac).toLowerCase();
  const rows = db.queryClientSamples(start, end, m);
  const wifi = rows.filter((r) => !r.wired);
  const last = rows[rows.length - 1] || null;
  const sig = wifi.map((r) => r.signal).filter((s) => s != null);

  const perAp = new Map();
  for (const r of wifi) {
    const key = `${r.ap_mac}|${r.radio}`;
    const cur = perAp.get(key) || { ap: nameOf(r.ap_mac), band: bandName(r.radio), minutes: 0, signals: [], lastSeen: 0 };
    cur.minutes += SAMPLE_MIN;
    if (r.signal != null) cur.signals.push(r.signal);
    cur.lastSeen = Math.max(cur.lastSeen, r.ts);
    perAp.set(key, cur);
  }
  let dwell = [...perAp.values()]
    .map((d) => ({ ap: d.ap, band: d.band, minutes: d.minutes, avgSignal: avg(d.signals), lastSeen: d.lastSeen }))
    .sort((a, b) => b.minutes - a.minutes || b.lastSeen - a.lastSeen);
  // No Wi-Fi samples in the period: signal at each logged connect / roam / disconnect, and
  // time per AP from the log's segments (UU-C-102).
  const log = rows.length ? null : logHistory(start, end, m).get(m) || null;
  let logSeries = null;
  if (log && !log.last?.wired) {
    const points = log.events.filter((e) => !e.wired && e.signal != null);
    logSeries = bucketsOf(points, start, end, (g) => ({
      signal: avg(g.map((e) => e.signal)),
      minSignal: minOf(g.map((e) => e.signal)),
      satisfaction: null,
      band: g[g.length - 1].band,
      ap: g[g.length - 1].via,
    }));
    const per = new Map();
    for (const sg of log.segments) {
      const k = `${sg.via}|${sg.band}`;
      const cur = per.get(k) || { ap: sg.via, band: sg.band, minutes: 0, signals: [], lastSeen: 0 };
      cur.minutes += Math.round((sg.to - sg.from) / 60e3);
      cur.lastSeen = Math.max(cur.lastSeen, sg.to);
      per.set(k, cur);
    }
    for (const e of points) {
      const cur = per.get(`${e.via}|${e.band}`);
      if (cur) cur.signals.push(e.signal);
    }
    dwell = [...per.values()]
      .map((d) => ({ ap: d.ap, band: d.band, minutes: d.minutes, avgSignal: avg(d.signals), lastSeen: d.lastSeen }))
      .sort((a, b) => b.minutes - a.minutes || b.lastSeen - a.lastSeen);
  }

  // Favourite AP: always over the last 30 days, per the Stalker definition.
  const now = Date.now();
  const month = db.queryClientSamples(now - 30 * 86400e3, now + 1, m).filter((r) => !r.wired);
  const favMap = new Map();
  for (const r of month) {
    const cur = favMap.get(r.ap_mac) || { minutes: 0, lastSeen: 0 };
    cur.minutes += SAMPLE_MIN;
    cur.lastSeen = Math.max(cur.lastSeen, r.ts);
    favMap.set(r.ap_mac, cur);
  }
  const fav = [...favMap.entries()].sort((a, b) => b[1].minutes - a[1].minutes || b[1].lastSeen - a[1].lastSeen)[0];

  // Presence: average minutes connected per hour-of-day x weekday, over every sample we
  // have for this client (up to 90 days), divided by how often that slot occurred while
  // the collector was running.
  const all = db.queryClientSamples(now - 90 * 86400e3, now + 1, m);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric" });
  const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const slotOf = (ts) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
    return { dow: DOW[p.weekday], hour: Number(p.hour) % 24, day: `${p.year}-${p.month}-${p.day}` };
  };
  const minutes = Array.from({ length: 24 }, () => Array(7).fill(0));
  for (const r of all) {
    const s = slotOf(r.ts);
    minutes[s.hour][s.dow] += SAMPLE_MIN;
  }
  // How many times each slot was observed at all (any client sample in that hour).
  const firstTs = db.firstClientSampleTs() || now;
  const seen = Array.from({ length: 24 }, () => Array(7).fill(0));
  for (let t = Math.floor(firstTs / 3600e3) * 3600e3; t < now; t += 3600e3) {
    const s = slotOf(t);
    seen[s.hour][s.dow] += 1;
  }
  const presence = minutes.map((row, h) => row.map((v, d) => (seen[h][d] ? Math.round(v / seen[h][d]) : 0)));
  const daysOfData = Math.floor((now - firstTs) / 86400e3);

  return {
    mac: m,
    name: nameOf(m),
    wired: last ? Boolean(last.wired) : log?.last ? log.last.wired : null,
    // "log" when the signal and AP figures come from UniFi's System Log, not samples.
    source: rows.length ? "samples" : logSeries ? "log" : null,
    current: last
      ? {
          ts: last.ts,
          ap: nameOf(last.ap_mac),
          band: bandName(last.radio),
          channel: last.channel,
          width: last.width,
          essid: last.essid,
          signal: last.signal,
          noise: last.noise,
          txRate: last.tx_rate,
          rxRate: last.rx_rate,
          satisfaction: last.satisfaction,
        }
      : null,
    summary: {
      avgSignal: avg(logSeries ? log.events.map((e) => e.signal) : sig),
      minSignal: minOf(logSeries ? log.events.map((e) => e.signal) : sig),
      weakMinutes: logSeries ? null : sig.filter((s) => s < WEAK).length * SAMPLE_MIN,
      badMinutes: logSeries ? null : sig.filter((s) => s < BAD).length * SAMPLE_MIN,
      minutes: logSeries ? dwell.reduce((n, d) => n + d.minutes, 0) : wifi.length * SAMPLE_MIN,
      satisfaction: avg(wifi.map((r) => r.satisfaction)),
    },
    thresholds: { weak: WEAK, bad: BAD },
    series: logSeries || bucketsOf(wifi, start, end, (g) => ({
      signal: avg(g.map((r) => r.signal)),
      minSignal: minOf(g.map((r) => r.signal)),
      satisfaction: avg(g.map((r) => r.satisfaction)),
      band: bandName(g[g.length - 1].radio),
      ap: nameOf(g[g.length - 1].ap_mac),
    })),
    dwell,
    favoriteAp: fav ? { ap: nameOf(fav[0]), hours: Math.round((fav[1].minutes / 60) * 10) / 10 } : null,
    roams: roamsFor(start, end, m).slice(0, 100),
    presence: { minutes: presence, daysOfData, sufficient: daysOfData >= 7 },
    // When this installation took its first sample: signal figures only cover time after it,
    // while roams come from UniFi's event log and cover the whole period (UU-C-084).
    sampledSince: firstTs,
  };
}

// ---- threats ----------------------------------------------------------------------------

// A packet from outside to a device (a ping reply, a probe): UniFi records the outside address
// as the source but puts the device's own name on both ends, and flips the networks. Turn it
// round so the source is the device and the destination the outside address (UU-C-183).
const PRIVATE_IP = /^(10|127|192\.168|172\.(1[6-9]|2\d|3[01]))\./;
export function inboundFixed(d) {
  const s = d?.source;
  const t = d?.destination;
  if (!s?.ip || !t?.ip || PRIVATE_IP.test(s.ip) || !PRIVATE_IP.test(t.ip) || !s.name || s.name !== t.name) return d;
  return {
    ...d,
    inbound: true,
    inNetwork: d.outNetwork,
    outNetwork: d.inNetwork,
    source: { ...s, ip: t.ip, network: t.network || s.network, subnet: t.subnet || s.subnet },
    destination: { name: null, domain: null, ip: s.ip, port: s.port, region: s.region, zone: null, network: null },
    domain: null,
  };
}

// Stored as the connection record counts it: bytesTx reached the source, which is the device
// unless the record was turned round above (UU-C-191).
function withDirection(d) {
  if (!d?.traffic) return d;
  const { bytesRx, bytesTx } = d.traffic;
  return { ...d, traffic: { ...d.traffic, down: d.inbound ? bytesRx : bytesTx, up: d.inbound ? bytesTx : bytesRx } };
}

// A System Log rule by its current name (UU-C-185): ids learned from the connection records.
// The id is taken as it comes, whatever its form ("<id>", or "obj_<id>_<n>" for an Object):
// Network 11 changed rules from 24-hex ids to UUIDs (UU-C-236), and a later update may again.
// An old id follows its rule to the new one (`policy_aliases`, UU-C-237).
function ruleNames() {
  let names = new Map();
  let aliases = new Map();
  try {
    names = new Map(JSON.parse(db.getSetting("policy_names", "[]")));
    aliases = new Map(JSON.parse(db.getSetting("policy_aliases", "[]")));
  } catch {
    /* the System Log's own names */
  }
  const nameOf = (id) => (id ? names.get(aliases.get(id)) ?? names.get(id) : undefined);
  return (trigger) => {
    if (!trigger?.n) return null;
    const raw = String(trigger.i || "");
    return nameOf(raw) ?? nameOf(/^obj_(.+)_\d+$/.exec(raw)?.[1]) ?? trigger.n;
  };
}

export function threats(start, end) {
  const rows = db.querySiemEvents(start, end, null).filter((e) => e.kind === "log" && /security/i.test(e.category || ""));
  // Signatures read from the matching flow records (UU-C-071); none for firewall blocks.
  const sigs = db.ipsDetails(start, end);
  const currentRuleName = ruleNames();
  const items = rows.map((e) => {
    const p = e.data?.params || {};
    const firewall = /TRAFFIC_BLOCKED/.test(e.data?.key || "");
    const ips = withDirection(inboundFixed(sigs.get(e.uid) || null));
    return {
      uid: e.uid,
      ts: e.ts,
      kind: firewall ? "Firewall block" : "Threat blocked",
      severity: e.data?.severity || null,
      // The blocked connection's full record (UU-C-077), for the detail panel.
      detail: ips,
      title: e.name,
      source: p.SRC_CLIENT?.n || p.SRC_IP?.n || null,
      target: p.DST_CLIENT?.n || p.DST_IP?.n || null,
      policy: currentRuleName(p.TRIGGER) || ips?.policy || null,
      // The name the rule had when it fired.
      logged: p.TRIGGER?.n || null,
      signature: ips?.signature || null,
      signatureId: ips?.signatureId || null,
      ipsCategory: ips?.category || null,
      domain: ips?.domain || null,
      risk: ips?.risk || null,
      note: ips?.note || null,
      msg: e.data?.msg || null,
    };
  });
  const top = (key) => {
    const m = new Map();
    for (const it of items) if (it[key]) m.set(it[key], (m.get(it[key]) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ name, count }));
  };
  return {
    total: items.length,
    threats: items.filter((i) => i.kind === "Threat blocked").length,
    firewall: items.filter((i) => i.kind === "Firewall block").length,
    topSources: top("source"),
    topTargets: top("target"),
    topPolicies: top("policy"),
    topSignatures: top("signature"),
    // Threat events still waiting for (or past the reach of) a signature lookup.
    threatsWithoutSignature: items.filter((i) => i.kind === "Threat blocked" && !i.signature).length,
    items: items.slice(0, 300),
  };
}
