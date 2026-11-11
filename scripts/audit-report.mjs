// Walks every screen the report can produce and fails if its numbers disagree.
//
//   npm run audit                          # against the running app on :3780
//   node scripts/audit-report.mjs http://127.0.0.1:3781
//
// For every cached day (and the 7-day view): the whole network, every device, every app
// on that device, and the services only our classifier names. Each screen must satisfy:
//   header     == Apps table total   == categories total == devices total
//   header     == chart bars + unplacedBytes
//   chart bars == listed sessions + sessionsOmitted          (hourly screens)
// This exists because the owner should not have to find broken screens one screenshot
// at a time: before UU-C-043, 384 of 461 device/app/day selections drew an empty chart
// under a non-empty header, and each was only found when someone looked at it.
import { annotateFlow } from "../server/classify.js";

// A connection record counts from the gateway: bytes_tx reached the device (UU-C-191). A camera,
// which uploads, read as downloading while this was the wrong way round.
const dir = annotateFlow({ source: { mac: "aa" }, destination: {}, flow_start_time: 1, traffic_data: { bytes_total: 100, bytes_rx: 90, bytes_tx: 10 } });
if (dir.bytesTx !== 90 || dir.bytesRx !== 10) throw new Error(`flow direction is swapped: down ${dir.bytesRx}, up ${dir.bytesTx}`);

const base = (process.argv[2] || process.env.UNIFI_URL || "http://127.0.0.1:3780").replace(/\/$/, "");
const TOL = (a, b) => Math.abs(a - b) <= Math.max(64 * 1024, 0.002 * Math.max(a, b));
const sum = (list, f) => (list || []).reduce((n, x) => n + Number(f(x) || 0), 0);
const MB = (x) => `${(x / 1048576).toFixed(1)} MB`;

async function get(path) {
  const res = await fetch(base + path);
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

const failures = [];
const stats = { screens: 0, dpi: 0, flows: 0, fullyPlaced: 0, partlyPlaced: 0, unplacedBytes: 0, headerBytes: 0 };

function check(label, r, { appSelected }) {
  stats.screens += 1;
  stats[r.basis] += 1;
  const header = r.totals.bytes;
  const chart = sum(r.timeline, (b) => b.totalBytes);
  const problems = [];
  if (appSelected) {
    const row = r.apps.length === 1 ? r.apps[0].totalBytes : sum(r.apps, (a) => a.totalBytes);
    if (!TOL(row, header)) problems.push(`Apps row ${MB(row)} != header ${MB(header)}`);
  } else if (!TOL(sum(r.apps, (a) => a.totalBytes), header)) {
    problems.push(`Apps table ${MB(sum(r.apps, (a) => a.totalBytes))} != header ${MB(header)}`);
  }
  const cats = sum(r.categories, (c) => c.totalBytes);
  if (r.categories.length && !TOL(cats, header)) problems.push(`categories ${MB(cats)} != header ${MB(header)}`);
  const devs = sum(r.clients, (c) => c.totalBytes);
  if (r.clients.length && !TOL(devs, header)) problems.push(`devices ${MB(devs)} != header ${MB(header)}`);
  if (!TOL(chart + r.unplacedBytes, header)) {
    problems.push(`chart ${MB(chart)} + unplaced ${MB(r.unplacedBytes)} != header ${MB(header)}`);
  }
  if (r.grain === "hour") {
    const listed = sum(r.sessions, (s) => s.bytes) + r.sessionsOmitted.bytes;
    if (!TOL(listed, chart)) problems.push(`sessions ${MB(listed)} != chart ${MB(chart)}`);
  }
  if (r.timeline.some((b) => !(b.coverage > 0) && b.totalBytes > 0)) problems.push("bar drawn in an hour with no detail");
  // Down + up is the total, wherever both are shown (UU-C-191).
  if (!TOL(r.totals.rx + r.totals.tx, header)) problems.push(`down + up ${MB(r.totals.rx + r.totals.tx)} != header ${MB(header)}`);
  const barSplit = sum(r.timeline, (b) => b.down) + sum(r.timeline, (b) => b.up);
  if (!TOL(barSplit, chart)) problems.push(`bars' down + up ${MB(barSplit)} != chart ${MB(chart)}`);
  // A session never names a destination bigger than itself (UU-C-192).
  for (const s of r.sessions) {
    if (s.source === "dpi" && (s.matchedBytes || 0) > 1.25 * s.bytes + 1024) problems.push(`${s.app} ${MB(s.bytes)} lists ${MB(s.matchedBytes)} of destinations`);
    if (!TOL(Number(s.down || 0) + Number(s.up || 0), s.bytes)) problems.push(`${s.app} down + up != ${MB(s.bytes)}`);
  }
  // "Not placed" is only allowed where time detail is actually missing. With full detail,
  // missing bytes mean the buckets lost them — the 5-minute seam loss (UU-F-049) hid
  // here as 14.7 GB of "unplaced" on a day with complete detail.
  if (r.grain === "hour" && r.detailCoverage >= 0.999 && !TOL(r.unplacedBytes, 0) && r.unplacedBytes > 0.005 * header) {
    problems.push(`${MB(r.unplacedBytes)} unplaced although every hour has detail`);
  }
  // Local traffic is flow-derived and must stay outside UniFi's own numbers: listed local
  // services can never exceed the local figure, and a local/detected screen (already flow
  // basis end to end) must not also carry one.
  if (sum(r.localServices, (l) => l.bytes) > r.localBytes + 1024) {
    problems.push(`local services ${MB(sum(r.localServices, (l) => l.bytes))} > localBytes ${MB(r.localBytes)}`);
  }
  if (r.basis === "flows" && r.localBytes) problems.push("flow-basis screen also reports localBytes");
  // Time in use (UU-C-108): sessions merged on the clock — never longer than the period, never
  // longer than the listed sessions back to back, never zero when there are sessions.
  if (r.time) {
    const span = r.end - r.start;
    const listedMs = sum(r.sessions, (s) => s.end - s.start);
    if (r.time.inUseMs > span + 1000) problems.push(`time in use ${r.time.inUseMs} ms > period ${span} ms`);
    if (r.time.sessions === r.sessionCount && r.sessions.length === r.sessionCount && r.time.inUseMs > listedMs + 1000) problems.push("time in use > its sessions back to back");
    if (r.time.sessions > 0 && !(r.time.inUseMs > 0)) problems.push("sessions but no time in use");
  }
  // UniFi daily totals fill only days with lost time, never per app or category (UU-C-057).
  if (r.timeline.some((b) => b.fillBytes > 0 && !(b.lost > 0))) problems.push("daily totals drawn on a day with no lost time");
  if (r.dailyFill?.totalBytes && (r.basis !== "dpi" || appSelected)) problems.push("daily totals on an app or flow screen");
  // Lost time (deleted by UniFi before it was saved) must carry no bytes, and must never be
  // counted as time detail (UU-F-053).
  if (r.timeline.some((b) => b.lost >= 0.999 && b.totalBytes > 0)) problems.push("bytes drawn in time marked lost");
  if (r.grain === "hour" && r.timeline.some((b) => b.lost >= 0.999 && b.coverage > 0)) problems.push("lost time counted as detail");
  if (header > 0) {
    stats.headerBytes += header;
    stats.unplacedBytes += r.unplacedBytes;
    if (r.unplacedBytes <= 0.002 * header) stats.fullyPlaced += 1;
    else stats.partlyPlaced += 1;
  }
  if (problems.length) failures.push(`${label}: ${problems.join("; ")}`);
}

const status = await get("/api/cache");
const dayKeys = (status.keys || []).filter((k) => k.fetchedAt).map((k) => k.key).sort();
const periods = [...dayKeys.map((d) => ({ q: `period=custom&date=${d}`, label: d })), { q: "period=7d", label: "7d" }, { q: "period=30d", label: "30d" }, { q: "period=90d", label: "90d" }];

// A clicked hour (UU-C-075): the two busiest hours of every day get the same walk, and the
// hour's header must equal that hour's bar in the day view.
const hourChecks = [];
for (const { q, label } of periods) {
  const net = await get(`/api/report?${q}`);
  check(`${label} network`, net, { appSelected: false });
  if (net.grain === "hour" && !label.includes(":")) {
    for (const bar of [...net.timeline].filter((b) => b.totalBytes > 0).sort((a, b) => b.totalBytes - a.totalBytes).slice(0, 2)) {
      const hq = `${q}&from=${bar.t}&to=${bar.t + 3600000}`;
      periods.push({ q: hq, label: `${label} ${bar.label}` });
      hourChecks.push({ hq, label: `${label} ${bar.label}`, dayBar: bar.totalBytes });
    }
  }
  for (const app of net.apps.filter((a) => a.totalBytes >= 1048576)) {
    check(`${label} network / ${app.app}`, await get(`/api/report?${q}&appId=${encodeURIComponent(app.appId)}`), { appSelected: true });
  }
  for (const client of net.clients.filter((c) => c.totalBytes >= 1048576)) {
    const qm = `${q}&mac=${encodeURIComponent(client.mac)}`;
    const dev = await get(`/api/report?${qm}`);
    check(`${label} ${client.name}`, dev, { appSelected: false });
    for (const app of dev.apps.filter((a) => a.totalBytes >= 1048576)) {
      check(`${label} ${client.name} / ${app.app}`, await get(`/api/report?${qm}&appId=${encodeURIComponent(app.appId)}`), { appSelected: true });
    }
    for (const svc of (dev.appChoices || []).filter((c) => c.source === "detected" || c.source === "local").slice(0, 6)) {
      check(`${label} ${client.name} / ${svc.app} (detected)`, await get(`/api/report?${qm}&appId=${encodeURIComponent(svc.value)}`), { appSelected: true });
    }
  }
  if (!label.includes(":")) await checkSites(q, label);
  process.stdout.write(`  ${label.padEnd(10)} ${String(stats.screens).padStart(6)} screens checked\n`);
}

// Sites (UU-C-135): every connection counted once, whatever the grouping, filter or device.
async function checkSites(q, label) {
  const one = async (qs, name) => {
    const s = await get(`/api/sites?${qs}`);
    stats.screens += 1;
    const bad = (m) => failures.push(`${label} sites ${name}: ${m}`);
    const listed = { n: sum(s.sites, (r) => r.n), bytes: sum(s.sites, (r) => r.bytes) };
    if (!s.truncated && (listed.n !== s.total.n || listed.bytes !== s.total.bytes)) bad(`rows ${listed.n}/${listed.bytes} != total ${s.total.n}/${s.total.bytes}`);
    if (!/cat=/.test(qs) && sum(s.categories, (c) => c.n) !== s.total.n) bad("category chips do not add up to the total");
    if (!/(cat|q)=/.test(qs) && s.total.n + s.hidden.n !== s.all.n) bad(`shown ${s.total.n} + hidden ${s.hidden.n} != all ${s.all.n}`);
    if (/bg=1/.test(qs) && s.hidden.n) bad("background hidden although asked for");
    return s;
  };
  const all = await one(`${q}&bg=1`, "all");
  const grouped = await one(`${q}&bg=1&group=domain`, "grouped");
  if (grouped.all.n !== all.all.n || grouped.all.bytes !== all.all.bytes) failures.push(`${label} sites: grouping by domain changed the totals`);
  await one(q, "default");
  const cat = all.categories[0];
  if (cat) {
    const c = await one(`${q}&bg=1&cat=${encodeURIComponent(cat.category)}`, cat.category);
    if (c.total.n !== cat.n) failures.push(`${label} sites: ${cat.category} chip says ${cat.n}, filtered list has ${c.total.n}`);
  }
  let perDevice = 0;
  for (const d of all.devices) perDevice += (await one(`${q}&bg=1&mac=${encodeURIComponent(d.mac)}`, d.name)).all.n;
  if (perDevice !== all.all.n) failures.push(`${label} sites: devices add up to ${perDevice}, all devices ${all.all.n}`);
  const top = all.sites[0];
  if (top) {
    const h = await get(`/api/sites/hits?${q}&bg=1&key=${encodeURIComponent(top.key)}`);
    if (!h.hits.length && top.last > 0) failures.push(`${label} sites: no connections behind ${top.site}`);
  }
}

for (const { hq, label, dayBar } of hourChecks) {
  const r = await get(`/api/report?${hq}`);
  if (Math.abs(r.totals.bytes - dayBar) > Math.max(1024, dayBar * 1e-6)) failures.push(`${label}: hour header ${r.totals.bytes} != day-view bar ${dayBar}`);
}

// A device's history (UU-C-198): every period, every switch, access point and gateway.
{
  const map = await get("/api/network");
  for (const n of [map.gateway, ...map.nodes].filter(Boolean)) {
    for (const days of [1, 7, 30, 90]) {
      const h = await get(`/api/network/history?mac=${encodeURIComponent(n.mac)}&days=${days}`);
      const label = `${n.name} history ${days}d`;
      stats.screens += 1;
      if (h.days !== days) failures.push(`${label}: answered for ${h.days} days`);
      for (const r of h.radios) {
        if (r.series.length !== Math.ceil((h.end - h.start) / h.step)) failures.push(`${label}: ${r.band} has ${r.series.length} bars`);
        if (r.series.some((s) => s.util != null && (s.util < 0 || s.util > s.peak || s.peak > 100))) failures.push(`${label}: ${r.band} busy outside 0-100 or above its peak`);
        const now = n.radios.find((x) => x.radio === r.radio);
        if (now && now.channel !== r.channel) failures.push(`${label}: ${r.band} ends on channel ${r.channel}, map says ${now.channel}`);
      }
      if (h.ports.some((p) => p.errors < 0)) failures.push(`${label}: negative errors`);
      if (h.events.some((e, i) => i && e.ts > h.events[i - 1].ts)) failures.push(`${label}: changes not newest first`);
    }
  }

  // The whole network over time (UU-C-213): bars per period, sane values, and every change on a
  // device's own history appears in the network's (when it is within the shown list).
  for (const days of [1, 7, 30, 90]) {
    const t = await get(`/api/network/timeline?days=${days}`);
    const label = `network history ${days}d`;
    stats.screens += 1;
    if (t.series.length !== Math.ceil((t.end - t.start) / t.step)) failures.push(`${label}: ${t.series.length} bars`);
    if (t.series.some((s) => (s.devices != null && (s.devices < 0 || s.wifi < 0 || s.wired < 0 || s.wifi + s.wired !== s.devices)) || (s.down != null && (s.down < 0 || s.down > s.downPeak)))) failures.push(`${label}: devices or speed out of range`);
    if (t.events.some((e, i) => i && e.ts > t.events[i - 1].ts)) failures.push(`${label}: changes not newest first`);
    if (!t.moreEvents) {
      for (const n of [map.gateway, ...map.nodes].filter(Boolean)) {
        const h = await get(`/api/network/history?mac=${encodeURIComponent(n.mac)}&days=${days}`);
        const missing = h.events.filter((e) => !t.events.some((x) => x.ts === e.ts && x.what === e.what));
        if (missing.length) failures.push(`${label}: ${missing.length} change(s) of ${n.name} missing, e.g. "${missing[0].what}"`);
      }
    }
  }

  // The map at a time (UU-C-213): asked for the newest sample's time, it is the live map.
  const atNow = await get(`/api/network?at=${map.ts}`);
  const chips = (m) => [m.gateway, ...m.nodes].filter(Boolean).flatMap((n) => n.clients.map((c) => `${n.mac}|${c.mac}|${c.port ?? ""}`)).concat((m.loose || []).map((c) => `-|${c.mac}`)).sort().join(",");
  stats.screens += 1;
  if (chips(atNow) !== chips(map)) failures.push("network map at now differs from the live map");
  if (atNow.wan?.ip !== map.wan?.ip) failures.push("network map at now shows another public IP");

  // Wi-Fi and Internet (UU-C-239): sane shares, the nearby list's sifted parts drawn from the
  // whole, every bar in place, outages inside the period.
  for (const days of [1, 7, 30]) {
    const w = await get(`/api/wifi/summary?days=${days}`);
    const label = `wifi ${days}d`;
    stats.screens += 1;
    for (const a of w.aps) for (const r of a.radios) if ([r.util, r.interf, r.avgUtil].some((v) => v != null && (v < 0 || v > 100)) || (r.interf != null && r.util != null && r.interf > r.util + 1)) failures.push(`${label}: ${a.name} ${r.band} busy share out of range`);
    const n = w.nearby;
    const keys = new Set(n.all.map((g) => `${g.name}|${g.band}`));
    if (n.competing.some((g) => !keys.has(`${g.name}|${g.band}`) || g.signal < n.threshold)) failures.push(`${label}: a competing network is not in the list or is too faint`);
    if (n.all.reduce((s, g) => s + g.radios, 0) > n.heard) failures.push(`${label}: more radios grouped than heard`);
    if (n.all.some((g) => !g.name && g.channels.length > 1)) failures.push(`${label}: hidden radios on different channels grouped as one`);
    // Channel advice (UU-C-241): only to a free, non-radar channel at least 10 points quieter.
    for (const a of w.advice || []) {
      if (!a.suggest) continue;
      const to = a.options.find((o) => o.channel === a.suggest.channel);
      if (!to || to.usedBy.length || to.dfs || to.current || !(a.current && a.current.util - to.util >= 10)) failures.push(`${label}: ${a.ap} ${a.band} told to move to ${a.suggest.channel} without reason`);
    }
    const i = await get(`/api/internet?days=${days}`);
    stats.screens += 1;
    if (i.series.length !== Math.ceil((i.end - i.start) / i.step)) failures.push(`internet ${days}d: ${i.series.length} bars`);
    if (i.availability != null && (i.availability < 0 || i.availability > 100)) failures.push(`internet ${days}d: availability ${i.availability}`);
    if (i.outages.some((o) => o.from < i.start - 1 || (o.to && o.to < o.from))) failures.push(`internet ${days}d: an outage outside the period`);
    if (i.series.some((s) => s.down != null && s.downPeak != null && s.down > s.downPeak + 0.1)) failures.push(`internet ${days}d: an average above its peak`);
  }
}

console.log(`\nscreens: ${stats.screens} (DPI basis ${stats.dpi}, flow basis ${stats.flows})`);
console.log(`chart places the whole header: ${stats.fullyPlaced}; part of it unplaced (no 5-minute detail): ${stats.partlyPlaced}`);
console.log(`bytes without time detail: ${MB(stats.unplacedBytes)} of ${MB(stats.headerBytes)} summed over screens`);
if (failures.length) {
  console.log(`\nFAIL ${failures.length} screen(s) disagree:`);
  for (const f of failures.slice(0, 40)) console.log(`  ${f}`);
  if (failures.length > 40) console.log(`  ... ${failures.length - 40} more`);
  process.exit(1);
}
console.log("\nPASS every screen adds up");
