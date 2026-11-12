// The Wi-Fi and Internet pages (UU-C-239). SQLite only, like insights.js: pages are built on view
// workers, which never talk to UniFi (health.refreshAir fetches what is read here).
import * as db from "./db.js";
import { bandName, channelSpan, names, wifiList } from "./insights.js";

const HOUR = 3600e3;
const STRONG = -80; // dBm: a neighbour this loud makes a radio on its channel wait its turn
const avg = (xs) => {
  const v = xs.filter((x) => x != null);
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
};
const maxOf = (xs) => {
  const v = xs.filter((x) => x != null);
  return v.length ? Math.max(...v) : null;
};
const overlaps = (a, b) => Boolean(a && b && a[0] <= b[1] && b[0] <= a[1]);
const BAND_OF = { ng: "2.4", na: "5", "6e": "6", "11be": "6" };

// 2.4 GHz channels that do not overlap one another (20 MHz wide, 5 MHz apart).
const CLEAN24 = [1, 6, 11];

// ---- Wi-Fi ---------------------------------------------------------------------------------
// Each access point's radios over the period: channel, width, power, how busy the channel was
// and how much of that was other networks. Then the devices (signal, band, roams, failed joins),
// and which ones sit on 2.4 GHz though they have used 5 or 6 GHz in the last 30 days.
export function wifiSummary(start, end) {
  const nameOf = names();
  const rows = db.queryDeviceSamples(start, end).filter((r) => r.type === "uap");
  const aps = new Map();
  for (const r of rows) {
    const a = aps.get(r.mac) || { mac: r.mac, name: r.name || nameOf(r.mac), model: r.model, online: false, radios: new Map(), last: 0 };
    if (r.ts >= a.last) {
      a.last = r.ts;
      a.online = r.state === 1;
    }
    for (const x of r.data.radios || []) {
      const h = a.radios.get(x.radio) || { radio: x.radio, utils: [], interfs: [], last: null };
      h.utils.push(x.util);
      h.interfs.push(x.interf);
      if (!h.last || r.ts >= h.lastTs) {
        h.last = x;
        h.lastTs = r.ts;
      }
      a.radios.set(x.radio, h);
    }
    aps.set(r.mac, a);
  }
  const order = { ng: 0, na: 1, "6e": 2 };
  // Network 11's statistics engine, last day (health.refreshAir): retries, satisfaction.
  let engine = {};
  try {
    engine = JSON.parse(db.getSetting("wifi_engine", "null"))?.aps || {};
  } catch {
    engine = {};
  }
  const apList = [...aps.values()].map((a) => ({
    mac: a.mac,
    name: a.name,
    model: a.model,
    online: a.online,
    day: engine[a.mac] || null,
    radios: [...a.radios.values()]
      .sort((x, y) => (order[x.radio] ?? 3) - (order[y.radio] ?? 3))
      .map((h) => ({
        radio: h.radio,
        band: bandName(h.radio),
        channel: h.last?.channel ?? null,
        width: h.last?.width ?? null,
        txPower: h.last?.txPower ?? null,
        clients: h.last?.clients ?? null,
        util: h.last?.util ?? null,
        interf: h.last?.interf ?? null,
        avgUtil: avg(h.utils),
        peakUtil: maxOf(h.utils),
        avgInterf: avg(h.interfs),
      })),
  }));
  apList.sort((x, y) => String(x.name).localeCompare(String(y.name)));

  const samples = db.queryClientSamples(start, end, null);
  const list = wifiList(start, end, samples).clients;
  const newest = list.reduce((m, c) => Math.max(m, c.lastSeen || 0), 0);
  // On 2.4 GHz at the period's last update, though seen on 5 or 6 GHz in the last 30 days.
  const on24 = list.filter((c) => c.lastSeen >= newest - 15 * 60e3 && c.band && /2\.4/.test(c.band));
  const faster = db.fasterBandSeen(on24.map((c) => c.mac), end - 30 * 24 * HOUR);
  const fails = new Map();
  for (const j of db.wifiJoins(start, end)) if (j.result !== "SUCCESS") fails.set(j.mac, (fails.get(j.mac) || 0) + (j.n || 1));
  const devices = list.map((c) => ({
    ...c,
    fasterSeen: faster.get(c.mac) && on24.includes(c) ? faster.get(c.mac) : undefined,
    failedJoins: fails.get(c.mac) || 0,
  }));
  const bands = {};
  for (const c of devices.filter((d) => d.lastSeen >= newest - 15 * 60e3)) bands[c.band || "?"] = (bands[c.band || "?"] || 0) + 1;
  return { aps: apList, devices, bandsNow: bands, newest: newest || null };
}

// ---- Nearby networks -----------------------------------------------------------------------
// UniFi hears hundreds of radios around a house; few matter. A network is grouped by name and
// band (one name often has several radios), and it matters when it is on a channel one of our
// radios uses and loud enough (STRONG) to make that radio wait. Counts per channel show where it
// is quieter. Everything else stays searchable.
export function nearbySummary(aps) {
  let stored = null;
  try {
    stored = JSON.parse(db.getSetting("nearby_networks", "null"));
  } catch {
    stored = null;
  }
  if (!stored?.rows) return { at: null, heard: 0, networks: 0, competing: [], channels: [], all: [] };
  const ours = aps.flatMap((a) => a.radios.filter((r) => r.channel).map((r) => ({ ap: a.name, radio: r.radio, band: BAND_OF[r.radio], channel: r.channel, width: r.width, span: channelSpan(r.radio, r.channel, r.width) })));
  // Named networks by name + band; hidden ones (no name to go by) by band + channel, so unrelated
  // hidden radios across the street are not one "network" on every channel (UU-C-241).
  const add = (map, key, r, band) => {
    const g = map.get(key) || { name: r.essid || null, band, channels: new Set(), width: null, signal: null, security: r.security, heardBy: new Set(), lastSeen: 0, radios: 0, hits: new Set() };
    g.radios += 1;
    if (r.channel) g.channels.add(r.channel);
    g.width = Math.max(g.width || 0, r.width || 0) || null;
    if (r.signal != null && (g.signal == null || r.signal > g.signal)) g.signal = r.signal;
    if (r.heardBy) g.heardBy.add(r.heardBy);
    g.lastSeen = Math.max(g.lastSeen, r.lastSeen || 0);
    map.set(key, g);
    return g;
  };
  const groups = new Map();
  // Sharing our channels: one row per network and channel, with that channel's own signal (a
  // network on 1, 6 and 11 is three rows, each as loud as it is there).
  const sharing = new Map();
  for (const r of stored.rows) {
    const band = BAND_OF[r.band];
    if (!band) continue;
    add(groups, r.essid ? `${r.essid}|${band}` : `|${band}|${r.channel}`, r, band);
    if (r.signal == null || r.signal < STRONG) continue;
    const span = channelSpan(r.band, r.channel, r.width);
    const hits = ours.filter((o) => o.band === band && overlaps(span, o.span));
    if (!hits.length) continue;
    const g = add(sharing, `${r.essid || ""}|${band}|${r.channel}`, r, band);
    for (const o of hits) g.hits.add(`${o.ap} ${bandName(o.radio)} ch ${o.channel}`);
  }
  const shape = (g) => ({ name: g.name, band: g.band, channels: [...g.channels].sort((a, b) => a - b), width: g.width, signal: g.signal, security: g.security, heardBy: [...g.heardBy], lastSeen: g.lastSeen || null, radios: g.radios, competes: [...g.hits] });
  const bySignal = (a, b) => (b.signal ?? -200) - (a.signal ?? -200);
  const all = [...groups.values()].map(shape).sort(bySignal);
  const competing = [...sharing.values()].map(shape).sort(bySignal);

  // Strong neighbours per channel (2.4 GHz: every channel, counting the networks ON it; the
  // non-overlapping 1, 6 and 11 are marked, UU-C-268) and per block of our 5 GHz width.
  const strong = stored.rows.filter((r) => r.signal != null && r.signal >= STRONG && BAND_OF[r.band]);
  const count = (band, radio, ch, width) => {
    const span = channelSpan(radio, ch, width);
    const hit = strong.filter((r) => BAND_OF[r.band] === band && overlaps(span, channelSpan(r.band, r.channel, r.width)));
    const mine = ours.filter((o) => o.band === band && overlaps(span, o.span)).map((o) => o.ap);
    const listened = mine.length > 0 || (span ? heardOn(band, span[0], span[1]) : false);
    return { channel: ch, width, listened, networks: listened ? new Set(hit.map((r) => r.essid || `hidden-${r.channel}`)).size : null, loudest: maxOf(hit.map((r) => r.signal)), ours: mine, busy: span ? busyOf(band, span[0], span[1]) : null };
  };
  const on24 = (ch) => {
    const hit = strong.filter((r) => BAND_OF[r.band] === "2.4" && Number(r.channel) === ch);
    const mine = ours.filter((o) => o.band === "2.4" && o.channel === ch).map((o) => o.ap);
    const listened = mine.length > 0 || heardOn("2.4", ch, ch);
    return { channel: ch, width: 20, clean: CLEAN24.includes(ch), listened, networks: listened ? new Set(hit.map((r) => r.essid || `hidden-${r.channel}`)).size : null, loudest: maxOf(hit.map((r) => r.signal)), ours: mine, busy: busyOf("2.4", ch, ch) };
  };
  const last24 = Math.max(11, ...strong.filter((r) => BAND_OF[r.band] === "2.4").map((r) => Number(r.channel) || 0).filter((c) => c <= 14));
  // UniFi lists only the networks your access points hear on the channels they use (on the
  // owner's console: 748 radios, all on 2.4 GHz 6 / 11 and their own 5 GHz blocks). A channel
  // none of them uses is "not reported", never 0; how busy it is comes from UniFi's RF scans,
  // which cover every channel (UU-C-276).
  const scans = db.rfScansSince(Date.now() - 30 * 24 * 3600e3);
  const busyOf = (band, lo, hi) => {
    const u = scans.filter((x) => BAND_OF[x.radio] === band && x.channel >= lo && x.channel <= hi && x.util != null).map((x) => x.util);
    return u.length ? Math.round(u.reduce((a, b) => a + b, 0) / u.length) : null;
  };
  // Listened = one of our radios is on it, or UniFi reported anything at all heard there.
  const heardOn = (band, lo, hi) => stored.rows.some((r) => BAND_OF[r.band] === band && Number(r.channel) >= lo && Number(r.channel) <= hi);
  const width5 = maxOf(ours.filter((o) => o.band === "5").map((o) => o.width)) || 80;
  // The first channel of each block of our width (80 MHz: 36, 52, 100, 116, 132, 149).
  const CH5 = [36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144, 149, 153, 157, 161, 165];
  const blocks5 = CH5.filter((c) => channelSpan("na", c, width5)?.[0] === c && (width5 <= 20 || c !== 165) && (width5 < 160 || c !== 149));
  const channels = [
    ...(ours.some((o) => o.band === "2.4") ? [{ band: "2.4", width: 20, rows: Array.from({ length: last24 }, (_, i) => on24(i + 1)) }] : []),
    ...(ours.some((o) => o.band === "5") ? [{ band: "5", width: width5, rows: [...new Set(blocks5)].map((c) => count("5", "na", c, width5)) }] : []),
  ];
  // 6 GHz: one line, as there is nothing to list unless a neighbour is heard there.
  const ours6 = ours.filter((o) => o.band === "6");
  const six = ours6.length ? { radios: ours6.map((o) => `${o.ap} ch ${o.channel}`), heard: strong.filter((r) => BAND_OF[r.band] === "6").length, anyHeard: stored.rows.filter((r) => BAND_OF[r.band] === "6").length } : null;
  return {
    at: stored.at,
    six,
    heard: stored.rows.length,
    networks: all.length,
    strong: all.filter((g) => g.signal != null && g.signal >= STRONG).length,
    threshold: STRONG,
    competing,
    channels,
    all,
  };
}

// ---- Channel advice from UniFi's RF scans (UU-C-241) -------------------------------------
// An access point mostly hears networks on its own channel, so counting neighbours makes a
// channel nobody here uses look empty. UniFi's RF scan measures every channel; NetLens keeps
// each one (UniFi keeps only the latest) and averages the last 30 days per access point. A move
// is suggested only when another channel was at least 10 points quieter on average, never onto
// a channel another of our access points uses in that band, and on 5 GHz never onto radar (DFS)
// channels. Scans run at night (UniFi's nightly scan) unless someone runs one, so daytime can
// differ; the radio's own daytime busy share is shown beside it.
const ADVISE_POINTS = 10;
const isDfs5 = (ch) => ch >= 52 && ch <= 144;
export function channelAdvice(aps, now) {
  const scans = db.rfScansSince(now - 30 * 24 * HOUR);
  const out = [];
  // A suggested channel is claimed, so two access points are never sent to the same one.
  const claimed = [];
  for (const a of aps) {
    for (const r of a.radios) {
      const band = BAND_OF[r.radio];
      if (!["2.4", "5", "6"].includes(band)) continue;
      const rows = scans.filter((s) => s.mac === a.mac && s.radio === r.radio);
      const base = { ap: a.name, mac: a.mac, band, radio: r.radio, channel: r.channel, width: r.width, daytime: r.avgUtil };
      if (!rows.length) {
        out.push({ ...base, scans: 0 });
        continue;
      }
      const byCh = new Map();
      for (const s of rows) {
        const c = byCh.get(s.channel) || { channel: s.channel, width: s.width, utils: [] };
        c.utils.push(s.util);
        byCh.set(s.channel, c);
      }
      const times = [...new Set(rows.map((s) => s.ts))].sort((x, y) => x - y);
      const spanOf = (c) => channelSpan(r.radio, c.channel, c.width);
      const mine = channelSpan(r.radio, r.channel, r.width);
      // Channels another of our access points uses in this band.
      const taken = aps.filter((o) => o.mac !== a.mac).flatMap((o) => o.radios.filter((x) => BAND_OF[x.radio] === band && x.channel).map((x) => ({ ap: o.name, channel: x.channel, span: channelSpan(x.radio, x.channel, x.width) })));
      // 2.4 GHz: every scanned channel is shown, but only 1, 6 and 11 (which do not overlap one
      // another) are ever suggested; there "this radio" and "used by" mean that exact channel
      // (UU-C-268).
      const is24 = band === "2.4";
      const options = [...byCh.values()]
        .map((c) => {
          const blockedBy = taken.filter((t) => overlaps(spanOf(c), t.span)).map((t) => t.ap);
          const usedBy = is24 ? taken.filter((t) => t.channel === c.channel).map((t) => t.ap) : blockedBy;
          return { channel: c.channel, width: c.width, util: avg(c.utils), dfs: band === "5" && isDfs5(c.channel), usedBy, blockedBy, clean: is24 ? CLEAN24.includes(c.channel) : undefined, current: is24 ? c.channel === r.channel : overlaps(spanOf(c), mine) };
        })
        .sort((x, y) => x.channel - y.channel);
      const current = options.find((o) => o.current) || null;
      const pickable = options.filter((o) => !o.current && !o.dfs && !o.blockedBy.length && o.clean !== false && o.util != null && !claimed.some((c) => c.band === band && overlaps(c.span, channelSpan(r.radio, o.channel, o.width))));
      const best = pickable.sort((x, y) => x.util - y.util)[0] || null;
      const suggest = current?.util != null && best && current.util - best.util >= ADVISE_POINTS ? { channel: best.channel, util: best.util } : null;
      if (suggest) claimed.push({ band, span: channelSpan(r.radio, best.channel, best.width) });
      out.push({ ...base, scans: times.length, firstAt: times[0], lastAt: times[times.length - 1], current: current ? { channel: current.channel, util: current.util } : null, options, suggest });
    }
  }
  return out;
}

// One day of the internet line (UU-C-254): the busiest download and upload (the engine's 5-minute
// peaks where it has them, else the busiest update), average latency, and minutes down out of the
// minutes NetLens watched. The day's traffic totals come from the caller (the usage day files).
export function wanDayStats(start, end) {
  const wan = db.queryWanSamples(start, end);
  const engine = db.wanEngineIn(start, end);
  const mbps = (bps) => (bps == null ? null : Math.round(bps / 1e5) / 10);
  const peak = (eKey, sKey) => {
    const e = maxOf(engine.map((x) => x[eKey]));
    const s = maxOf(wan.map((x) => (x[sKey] == null ? null : x[sKey] * 8)));
    return mbps(maxOf([e, s]));
  };
  let watched = 0;
  let down = 0;
  for (let i = 1; i < wan.length; i += 1) {
    const gap = wan[i].ts - wan[i - 1].ts;
    if (gap > 20 * 60e3) continue;
    watched += gap;
    if (wan[i - 1].status && wan[i - 1].status !== "ok") down += gap;
  }
  return {
    peakDown: peak("rxMax", "rx_rate"),
    peakUp: peak("txMax", "tx_rate"),
    latency: avg(wan.map((w) => w.latency)),
    downMinutes: Math.round(down / 60e3),
    watchedHours: Math.round((watched / 3600e3) * 10) / 10,
  };
}

// ---- Internet ------------------------------------------------------------------------------
// Did the line deliver? Availability and every outage, latency to UniFi's test targets, and how
// much of the link the busiest moments used. NetLens's samples see each update's moment; Network
// 11's statistics engine (wan_engine) has each 5 minutes' busiest rate, used where it exists.
export function internetSummary(days, now) {
  const start = now - days * 24 * HOUR;
  const wan = db.queryWanSamples(start, now + 1);
  const engine = db.wanEngineIn(start, now + 1);
  const step = days <= 1 ? 1800e3 : days <= 7 ? 4 * HOUR : 12 * HOUR;
  const count = Math.ceil((now - start) / step);
  const slot = (ts) => Math.min(count - 1, Math.max(0, Math.floor((ts - start) / step)));
  const slots = Array.from({ length: count }, () => ({ latency: [], down: [], up: [], peakDown: [], peakUp: [], bad: 0, n: 0 }));
  const ok = (w) => !w.status || w.status === "ok";
  // Outages: from the first bad update to the first good one. A gap of over 20 minutes between
  // updates is time NetLens did not see, not an outage.
  const outages = [];
  let cur = null;
  let prev = null;
  let seenMs = 0;
  let badMs = 0;
  for (const w of wan) {
    const g = slots[slot(w.ts)];
    g.n += 1;
    if (w.latency != null) g.latency.push(w.latency);
    if (w.rx_rate != null) g.down.push((w.rx_rate * 8) / 1e6);
    if (w.tx_rate != null) g.up.push((w.tx_rate * 8) / 1e6);
    if (!ok(w)) g.bad += 1;
    if (prev) {
      const gap = w.ts - prev.ts;
      if (gap <= 20 * 60e3) {
        seenMs += gap;
        if (!ok(prev)) badMs += gap;
      }
    }
    if (!ok(w) && !cur) cur = { from: w.ts, status: w.status };
    else if (ok(w) && cur) {
      outages.push({ ...cur, to: w.ts, minutes: Math.max(1, Math.round((w.ts - cur.from) / 60e3)) });
      cur = null;
    }
    prev = w;
  }
  if (cur) outages.push({ ...cur, to: null, minutes: Math.max(1, Math.round((now - cur.from) / 60e3)) });
  for (const e of engine) {
    const g = slots[slot(e.ts)];
    if (e.rxMax != null) g.peakDown.push(e.rxMax / 1e6);
    if (e.txMax != null) g.peakUp.push(e.txMax / 1e6);
  }
  const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
  const series = slots.map((g, i) => ({
    t: start + i * step,
    latency: avg(g.latency),
    down: r1(avg(g.down)),
    up: r1(avg(g.up)),
    downPeak: r1(maxOf([...g.peakDown, ...g.down])),
    upPeak: r1(maxOf([...g.peakUp, ...g.up])),
    outage: g.bad > 0,
    nodata: g.n === 0,
  }));
  const lat = wan.map((w) => w.latency).filter((x) => x != null).sort((a, b) => a - b);
  const pct = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] : null);
  // Per test target (ping.ui.com, 1.1.1.1, 8.8.8.8…): average latency and availability.
  const targets = new Map();
  for (const w of wan) {
    for (const m of w.data?.monitors || []) {
      const k = `${m.target}|${m.type}`;
      const t = targets.get(k) || { target: m.target, type: m.type, latency: [], availability: [] };
      t.latency.push(m.latency);
      t.availability.push(m.availability);
      targets.set(k, t);
    }
  }
  // The busiest 5 minutes: the engine's, else the busiest update.
  const peakOf = (pick, sample) => {
    const e = engine.reduce((best, x) => (x[pick] != null && (!best || x[pick] > best[pick]) ? x : best), null);
    const s = wan.reduce((best, x) => (x[sample] != null && (!best || x[sample] > best[sample]) ? x : best), null);
    const eMbps = e ? e[pick] / 1e6 : null;
    const sMbps = s ? (s[sample] * 8) / 1e6 : null;
    if (eMbps == null && sMbps == null) return null;
    return eMbps != null && (sMbps == null || eMbps >= sMbps) ? { mbps: r1(eMbps), at: e.ts, from: "engine" } : { mbps: r1(sMbps), at: s.ts, from: "sample" };
  };
  const gw = db.latestDeviceSamples().find((d) => /udm|ugw|uxg/.test(d.type || ""));
  const wanPort = (gw?.data?.ports || []).find((p) => p.wan && p.up);
  const linkMbps = wanPort?.speed || gw?.data?.uplink?.speed || null;
  const last = wan[wan.length - 1] || null;
  const runs = db.publicIpRuns(start).map((r) => (r.to > now ? { ...r, to: now } : r));
  return {
    days,
    start,
    end: now,
    step,
    samples: wan.length,
    engine: engine.length > 0,
    isp: last?.isp || null,
    ip: last?.data?.ip || null,
    status: last ? { ok: ok(last), status: last.status, latency: last.latency, ts: last.ts } : null,
    linkMbps,
    availability: seenMs ? Math.round((1 - badMs / seenMs) * 10000) / 100 : null,
    seenHours: Math.round((seenMs / HOUR) * 10) / 10,
    outages: outages.reverse().slice(0, 50),
    outageCount: outages.length,
    latency: { avg: avg(lat), p95: pct(0.95), max: lat.length ? lat[lat.length - 1] : null, min: lat.length ? lat[0] : null },
    targets: [...targets.values()].map((t) => ({ target: t.target, type: t.type, latency: avg(t.latency), availability: avg(t.availability) })).sort((a, b) => (a.latency ?? 999) - (b.latency ?? 999)),
    peakDown: peakOf("rxMax", "rx_rate"),
    peakUp: peakOf("txMax", "tx_rate"),
    speedtest: gw?.data?.speedtest || null,
    ipHistory: runs.slice(-12).reverse(),
    series,
  };
}
