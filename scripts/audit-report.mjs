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
  process.stdout.write(`  ${label.padEnd(10)} ${String(stats.screens).padStart(6)} screens checked\n`);
}

for (const { hq, label, dayBar } of hourChecks) {
  const r = await get(`/api/report?${hq}`);
  if (Math.abs(r.totals.bytes - dayBar) > Math.max(1024, dayBar * 1e-6)) failures.push(`${label}: hour header ${r.totals.bytes} != day-view bar ${dayBar}`);
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
