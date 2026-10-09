import fs from "node:fs";
import path from "node:path";
import { databaseDir } from "./paths.js";
import * as unifi from "./unifi.js";
import { annotateFlow, reclassifyCachedRow, nameBareIpFlows, CLASSIFIER_VERSION } from "./classify.js";
import { logError } from "./log.js";
import { fetchBuckets, fetchHourly, BUCKET_REACH_MS, HOUR_MS } from "./buckets.js";

const BUCKET_SETTLE_MS = 30 * 60 * 1000;
// Bumped when 5-minute buckets on disk are known to be wrong, forcing one full re-read of
// UniFi's last ~23 h. 2 = built before the settle overlap, short at every seam (UU-F-049).
const BUCKET_VERSION = 2;

// One storage unit = one local day. `today`, `yesterday` and `custom:<date>` each
// resolve to a single day; `7d` composes seven of them and stores nothing of its own.
// Named ranges that slide (the old `yesterday` / `7d` buckets) could not be pruned or
// evicted, which is what inflated totals and grew the cache to 399 MB.
const cacheDir = path.join(databaseDir, "cache");
const legacyFile = path.join(databaseDir, "unifi-cache.json");
const OVERLAP_MS = 60 * 1000;
// Keep a month on disk, but only ever ask UniFi for the recent window (see
// FETCH_DAYS in index.js). Days age out of RETAIN_DAYS long after they stop being
// fetched, so "Pick a day" reaches back 30 days while console load stays flat.
export const RETAIN_DAYS = 30;

const days = new Map();
let lastError = null;
let warmup = null;

function dayEntry(dayKey, start, end) {
  return {
    dayKey,
    start,
    end,
    traffic: [],
    flows: [],
    // 5-minute DPI rows [t, mac, appId, catId, rx, tx, act] and the [from, to) spans they
    // cover. Outside a span there is no time detail for that part of the day.
    buckets: [],
    bucketSpans: [],
    coveredThrough: 0,
    fetchedAt: 0,
    closedTrafficRead: false,
    warming: false,
    pending: null,
  };
}

function dayFile(dayKey) {
  return path.join(cacheDir, `day-${dayKey}.json`);
}

function flowId(flow) {
  return flow.id || `${flow.t}|${flow.mac}|${flow.domain}|${flow.bytes}`;
}

// Flows are classified once, here, and stored already annotated. /api/report used to
// re-run annotateFlow over every cached flow on every request — measured at 229,978
// flows / 2369 ms, while the filtering it fed took 4 ms. The stored row is also
// smaller than the raw slim flow, since the nested source/destination/traffic_data
// objects collapse away. Trade-off: editing a rule in classify.js now needs a
// Refetch all to take effect, instead of applying on the next request.
function toCachedFlow(raw) {
  if (raw && typeof raw.app === "string" && typeof raw.t === "number") return raw;
  const row = annotateFlow(raw);
  if (raw?.id != null) row.id = raw.id;
  return row;
}

// Safe only across disjoint windows. Day buckets never overlap, and within a day the
// delta traffic window starts exactly at coveredThrough with no overlap, so every
// byte is counted once.
function mergeTraffic(base, delta) {
  const byMac = new Map();
  for (const item of base || []) {
    byMac.set(item.client.mac, {
      client: { ...item.client },
      usage: item.usage.map((u) => ({ ...u })),
    });
  }
  for (const item of delta || []) {
    const cur = byMac.get(item.client.mac);
    if (!cur) {
      byMac.set(item.client.mac, {
        client: { ...item.client },
        usage: item.usage.map((u) => ({ ...u })),
      });
      continue;
    }
    const apps = new Map(cur.usage.map((u) => [`${u.appId}:${u.catId}`, u]));
    for (const u of item.usage) {
      const key = `${u.appId}:${u.catId}`;
      const prev = apps.get(key);
      if (!prev) {
        cur.usage.push({ ...u });
        apps.set(key, cur.usage[cur.usage.length - 1]);
        continue;
      }
      prev.bytesRx += u.bytesRx;
      prev.bytesTx += u.bytesTx;
      prev.totalBytes += u.totalBytes;
      prev.activitySeconds += u.activitySeconds;
    }
  }
  return [...byMac.values()];
}

function mergeFlows(base, delta) {
  const seen = new Set();
  const out = [];
  for (const flow of [...(delta || []), ...(base || [])]) {
    const id = flowId(flow);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(flow);
  }
  return out;
}

function clampFlows(flows, start, end) {
  return (flows || []).filter((flow) => {
    const t = Number(flow.t || 0);
    return t >= start && t < end;
  });
}

// UniFi's v2 traffic endpoint returns an empty result for short windows and for a
// window spanning exactly 86400000 ms — which is precisely what a calendar day is, so
// closed days came back with no traffic at all and the Apps table rendered empty.
// Measured against the live console: [start, end] -> 0 clients, [start, end - 1000] ->
// 41 clients / 136 GB for the same day. So read a closed day as one whole-day request
// one second short of the boundary, rather than accumulating short delta windows that
// would each return nothing.
const DAY_END_NUDGE_MS = 1000;

// `start - 1`: the endpoint rounds a window's start up to the next hour, so a read that
// starts exactly at midnight silently drops 00:00-01:00 (UU-C-043).
async function readClosedDayTraffic(start, end) {
  return unifi.getTraffic(start - 1, end - DAY_END_NUDGE_MS);
}

function persistDay(entry) {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const tmp = `${dayFile(entry.dayKey)}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({
        dayKey: entry.dayKey,
        start: entry.start,
        end: entry.end,
        coveredThrough: entry.coveredThrough,
        fetchedAt: entry.fetchedAt,
        classifierVersion: CLASSIFIER_VERSION,
        closedTrafficRead: Boolean(entry.closedTrafficRead),
        traffic: entry.traffic,
        flows: entry.flows,
        buckets: entry.buckets || [],
        bucketSpans: entry.bucketSpans || [],
        hourlyRead: Number(entry.hourlyRead) || 0,
        fineSpans: entry.fineSpans || [],
        bucketVersion: entry.bucketVersion || 0,
      })
    );
    fs.renameSync(tmp, dayFile(entry.dayKey));
  } catch (err) {
    // A write failure must not fail the fetch that produced the data.
    lastError = `cache write failed: ${err.message}`;
    logError("cache persistDay", err, { dayKey: entry.dayKey });
  }
}

function restore() {
  try {
    if (!fs.existsSync(cacheDir)) return;
    const cutoff = Date.now() - RETAIN_DAYS * 86400000;
    let evicted = 0;
    let upgradedDays = 0;
    for (const name of fs.readdirSync(cacheDir)) {
      const match = /^day-(\d{4}-\d{2}-\d{2})\.json$/.exec(name);
      if (!match) continue;
      const file = path.join(cacheDir, name);
      try {
        const entry = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!entry?.fetchedAt || Number(entry.end) < cutoff) {
          fs.rmSync(file, { force: true });
          evicted += 1;
          continue;
        }
        // Days written before flows were annotated at rest are upgraded in place,
        // once, rather than thrown away and refetched. The same pass re-runs
        // classification when the classifier has moved on, so naming improvements reach
        // cached days without touching UniFi. Row-level reclassification works from each
        // row's stored `domain`; the whole-day pass that follows also names bare-IP rows
        // from other flows in the same day where UniFi resolved that address.
        let upgraded = false;
        const stale = Number(entry.classifierVersion || 0) !== CLASSIFIER_VERSION;
        const flows = (entry.flows || []).map((f) => {
          let row = toCachedFlow(f);
          if (row !== f) upgraded = true;
          if (stale) {
            const re = reclassifyCachedRow(row);
            if (re !== row) { row = re; upgraded = true; }
          }
          return row;
        });
        if (stale && (entry.flows || []).length) upgraded = true;
        const flows2 = stale ? nameBareIpFlows(flows) : flows;
        const restored = {
          dayKey: match[1],
          start: Number(entry.start),
          end: Number(entry.end),
          traffic: entry.traffic || [],
          flows: flows2,
          buckets: entry.buckets || [],
          bucketSpans: entry.bucketSpans || [],
          hourlyRead: Number(entry.hourlyRead) || 0,
          fineSpans: entry.fineSpans || (entry.hourlyRead ? [] : entry.bucketSpans || []),
          bucketVersion: Number(entry.bucketVersion || 0),
          coveredThrough: Number(entry.coveredThrough || entry.end || 0),
          fetchedAt: Number(entry.fetchedAt),
          classifierVersion: CLASSIFIER_VERSION,
          closedTrafficRead: Boolean(entry.closedTrafficRead),
          warming: false,
          pending: null,
        };
        days.set(match[1], restored);
        if (upgraded) {
          persistDay(restored);
          upgradedDays += 1;
        }
      } catch (err) {
        // One corrupt day must not cost the others.
        logError("cache restore day", err, { file: name });
        fs.rmSync(file, { force: true });
      }
    }
    console.log(
      `cache restored days=${days.size} from ${cacheDir}` +
        (upgradedDays ? ` (re-annotated ${upgradedDays} day file(s) in place, classifier v${CLASSIFIER_VERSION})` : "") +
        (evicted ? ` (evicted ${evicted} past ${RETAIN_DAYS}d)` : "")
    );
    if (fs.existsSync(legacyFile)) {
      console.log(
        `cache: legacy ${legacyFile} is superseded by per-day files and is no longer read — safe to delete`
      );
    }
  } catch (err) {
    logError("cache restore", err);
  }
}

restore();

export function hasDay(dayKey) {
  return Boolean(days.get(dayKey)?.fetchedAt);
}

export function cachedDayKeys() {
  return [...days.keys()].filter(hasDay).sort();
}

export function status() {
  const keys = [...days.entries()].map(([key, entry]) => ({
    key,
    fetchedAt: entry.fetchedAt || null,
    warming: Boolean(entry.warming),
    coveredThrough: entry.coveredThrough || null,
    trafficClients: entry.traffic?.length || 0,
    flows: entry.flows?.length || 0,
  }));
  const fetched = keys.filter((k) => k.fetchedAt).map((k) => k.fetchedAt);
  return {
    warming: keys.some((k) => k.warming) || Boolean(warmup && !warmup.done),
    ready: fetched.length > 0,
    fetchedAt: fetched.length ? Math.max(...fetched) : null,
    error: lastError,
    keys,
  };
}

// Read-only compose across whole local days. Never touches UniFi: a report renders
// whatever is cached, and the header's cache age says how old that is.
export function readDays(dayKeys) {
  const present = (dayKeys || []).map((k) => days.get(k)).filter(Boolean);
  let traffic = [];
  const flows = [];
  let fetchedAt = 0;
  for (const entry of present) {
    traffic = mergeTraffic(traffic, entry.traffic);
    // Not push(...entry.flows): spreading becomes one argument per element and V8
    // throws "Maximum call stack size exceeded" past ~100k. A single day now holds
    // 125k+ flows since the page cap was raised (UU-C-007), which is well past that.
    for (const flow of entry.flows) flows.push(flow);
    if (entry.fetchedAt > fetchedAt) fetchedAt = entry.fetchedAt;
  }
  const buckets = [];
  const bucketSpans = [];
  for (const entry of present) {
    for (const row of entry.buckets || []) buckets.push(row);
    for (const span of entry.bucketSpans || []) bucketSpans.push(span);
  }
  return {
    traffic,
    flows,
    buckets,
    bucketSpans,
    // Each day's own DPI totals, for a daily chart that adds up to the header exactly.
    perDay: present.map((e) => ({
      dayKey: e.dayKey,
      start: e.start,
      end: e.end,
      traffic: e.traffic,
      coveredThrough: e.coveredThrough || 0,
      fetchedAt: e.fetchedAt || 0,
    })),
    fetchedAt,
    missingDays: (dayKeys || []).filter((k) => !days.has(k)),
  };
}

export async function loadDay(dayKey, start, end, { mode = "read" } = {}) {
  const cur = days.get(dayKey) || dayEntry(dayKey, start, end);

  if (mode === "read") return cur;
  if (cur.pending && mode !== "full") return cur.pending;

  const now = Date.now();
  const fetchTo = Math.min(end, now);
  const full = mode === "full" || !cur.fetchedAt;
  const fetchFrom = full ? start : Math.max(start, cur.coveredThrough || start);

  const dayClosed = now >= end;

  // Self-heal days cached before the closed-day traffic read existed. Keying this on
  // "has flows" was wrong: UniFi keeps traffic longer than flows, so a day can hold
  // real traffic and no flows at all — 2026-09-14 had 412 GB behind zero flows and
  // never repaired. Track whether the whole-day read has been done instead, so every
  // day is retried exactly once and a genuinely empty day is not refetched forever.
  const needsTrafficRepair =
    dayClosed && Boolean(cur.fetchedAt) && !cur.traffic.length && !cur.closedTrafficRead;

  // A finished day already covered end-to-end needs nothing (REVIEW rule 3).
  if (!full && !needsTrafficRepair && fetchFrom >= fetchTo - 5000) return cur;
  if (!needsTrafficRepair && fetchFrom >= fetchTo) return cur;

  const pending = (async () => {
    lastError = null;
    // Flows dedupe by id, so re-reading the last minute is free insurance against a
    // flow that landed mid-fetch. Traffic is summed, so it must not overlap at all —
    // that overlap was the 60-second double-count.
    const flowFrom = Math.max(start, fetchFrom - OVERLAP_MS);
    // An open day is read whole too, from midnight to now, and replaces what we had.
    // Summing delta windows lost traffic: the endpoint drops whatever sits on a window
    // edge, so every delta seam was a place for bytes to fall through (UU-C-043).
    const [trafficRows, flowDelta] = await Promise.all([
      // An open day's total stops where its 5-minute buckets stop, so the chart and the
      // header describe the same moment. Read to "now", a busy torrent box left 14.7 GB
      // "not placed" for the minutes before the next bucket (UU-C-044).
      dayClosed
        ? readClosedDayTraffic(start, end)
        : unifi.getTraffic(start - 1, bucketsThrough() > start ? Math.min(fetchTo, bucketsThrough()) : fetchTo),
      unifi.getTrafficFlows({ startMs: flowFrom, endMs: fetchTo }).then((rows) => rows.map(toCachedFlow)),
    ]);
    // A closed day is read whole and replaces whatever partial traffic we had; an
    // open day accumulates. See readClosedDayTraffic for why.
    const traffic = dayClosed ? keepLargerDay(cur.traffic, trafficRows) : trafficRows;
    // Whole-day pass: a bare-IP flow borrows a name from another flow in the same day
    // where UniFi resolved that address. Run after the merge so the table is complete.
    // Always merge flows, even on a full refetch. UniFi drops flow history days before
    // it drops DPI traffic — a full replace of 2026-09-15 turned 36k flows into 7k from
    // the last three hours of that day and emptied the timeline. Traffic for a closed
    // day still replaces (the whole-day read is the accurate total).
    const flows = nameBareIpFlows(clampFlows(mergeFlows(cur.flows, flowDelta), start, end));
    const entry = {
      dayKey,
      start,
      end,
      traffic,
      flows,
      buckets: cur.buckets || [],
      bucketSpans: cur.bucketSpans || [],
      hourlyRead: Number(cur.hourlyRead) || 0,
      fineSpans: cur.fineSpans || [],
      bucketVersion: cur.bucketVersion || 0,
      coveredThrough: fetchTo,
      fetchedAt: Date.now(),
      classifierVersion: CLASSIFIER_VERSION,
      // Records that the closed-day whole-day traffic read has happened, so an
      // honestly-empty day is not retried on every warm.
      closedTrafficRead: dayClosed || Boolean(cur.closedTrafficRead),
      warming: false,
      pending: null,
    };
    // The total just changed; the buckets must not claim more than it.
    fitBucketsToTotals(entry);
    days.set(dayKey, entry);
    persistDay(entry);
    console.log(
      `cache ${full ? "full" : "delta"} ${dayKey} +${flowDelta.length} flows now=${flows.length}` +
        (full && cur.flows?.length > flowDelta.length
          ? ` (kept ${cur.flows.length - flowDelta.length} flows UniFi no longer returned)`
          : "")
    );
    return entry;
  })();

  days.set(dayKey, { ...cur, start, end, warming: true, pending });
  try {
    return await pending;
  } catch (err) {
    lastError = err.message;
    logError("cache loadDay", err, { dayKey });
    days.set(dayKey, { ...cur, warming: false, pending: null });
    throw err;
  }
}

// jobs: [{ dayKey, start, end }] — whole local days, oldest first.
export async function warm(jobs, { mode = "delta" } = {}) {
  if (mode !== "full" && warmup?.pending) return warmup.pending;
  const pending = (async () => {
    for (const job of jobs) {
      try {
        await loadDay(job.dayKey, job.start, job.end, { mode });
        const entry = days.get(job.dayKey);
        console.log(
          `cache ready ${job.dayKey} traffic=${entry?.traffic.length || 0} flows=${entry?.flows.length || 0}`
        );
      } catch (err) {
        lastError = err.message;
        logError("cache warm", err, { dayKey: job.dayKey });
      }
    }
  })();
  warmup = { pending, done: false };
  try {
    await pending;
    // After the days exist, so every bucket has a day file to land in. 5-minute detail
    // first: the hourly history only fills the hours it does not cover.
    await refreshBuckets({ full: mode === "full" });
    for (const job of jobs) await readHourlyHistory(job.dayKey, { full: mode === "full" });
  } finally {
    warmup = { pending: null, done: true };
  }
}

function mergeSpans(spans) {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

// Never let a day's buckets claim more than its total for any device+app. DPI keeps
// re-labelling traffic after the fact, so rows fetched in an earlier run can exceed the
// current figure (an Echo Show's SSL/TLS: 31.8 MB of rows against 29.6 MB). Scaling the
// key's rows down keeps chart <= header; any shortfall is the honest "not placed" part.
function fitBucketsToTotals(entry) {
  const total = new Map();
  for (const c of entry.traffic || []) {
    for (const u of c.usage) total.set(`${c.client.mac}|${u.catId}|${u.appId}`, u.totalBytes || u.bytesRx + u.bytesTx);
  }
  const have = new Map();
  for (const r of entry.buckets || []) {
    const k = `${r[1]}|${r[3]}|${r[2]}`;
    have.set(k, (have.get(k) || 0) + r[4] + r[5]);
  }
  const factor = new Map();
  for (const [k, h] of have) {
    const t = total.get(k) || 0;
    if (h > t) factor.set(k, h > 0 ? t / h : 0);
  }
  if (!factor.size) return;
  entry.buckets = (entry.buckets || [])
    .map((r) => {
      const f = factor.get(`${r[1]}|${r[3]}|${r[2]}`);
      if (f == null) return r;
      const y = [...r];
      y[4] = Math.floor(r[4] * f);
      y[5] = Math.floor(r[5] * f);
      y[6] = Math.floor(r[6] * f);
      return y;
    })
    .filter((r) => r[4] + r[5] > 0);
}

function trafficTotal(rows) {
  let n = 0;
  for (const c of rows || []) for (const u of c.usage) n += u.totalBytes || u.bytesRx + u.bytesTx;
  return n;
}

// A finished day only ever gains: re-reading it can add the midnight hour the old reads
// missed, but UniFi also ages days out, and near its retention edge a re-read returns
// less. On 2026-09-22 a re-read of Sep 15 came back 31.9 GB against 43.1 GB stored —
// the same shape as the flow wipe in UU-F-039. Keep whichever total is larger.
function keepLargerDay(stored, fresh) {
  return trafficTotal(fresh) >= trafficTotal(stored) ? fresh : stored;
}

function bucketsThrough() {
  let latest = 0;
  for (const entry of days.values()) {
    for (const [, b] of entry.bucketSpans || []) if (b > latest) latest = b;
  }
  return latest;
}

// Bring the 5-minute DPI buckets up to now. UniFi only keeps them for about a day, so
// this runs on every warm and every snapshot; a gap longer than BUCKET_REACH_MS (the app
// closed for more than a day) cannot be recovered and stays an explicit gap.
let bucketRefresh = null;
export async function refreshBuckets({ full = false } = {}) {
  if (bucketRefresh) return bucketRefresh;
  bucketRefresh = (async () => {
    const now = Date.now();
    const reach = now - BUCKET_REACH_MS;
    // Re-read the last half hour on every refresh and replace it. UniFi is still adding
    // to the newest buckets when they are first read; starting the next read after them
    // lost those late bytes at every 5-minute seam — 14% of a busy torrent box's day
    // (134.6 GB of buckets against a 156.4 GB total; one fresh pass matched exactly).
    const stale = [...days.values()].some(
      (e) => e.end > reach && (e.buckets || []).length && Number(e.bucketVersion || 0) < BUCKET_VERSION
    );
    const from = full || stale ? reach : Math.max(reach, bucketsThrough() - BUCKET_SETTLE_MS);
    const { rows, from: f, to } = await fetchBuckets(from, now);
    if (!(to > f)) return { rows: 0 };
    const touched = new Set();
    for (const entry of days.values()) {
      const a = Math.max(entry.start, f);
      const b = Math.min(entry.end, to);
      if (!(b > a) || !entry.fetchedAt) continue;
      const mine = rows.filter((r) => r[0] >= a && r[0] < b);
      // Replace, never add, inside the span just read: a full refresh must not double.
      const kept = (entry.buckets || []).filter((r) => r[0] < a || r[0] >= b);
      entry.buckets = kept.concat(mine).sort((x, y) => x[0] - y[0]);
      entry.bucketSpans = mergeSpans([...(entry.bucketSpans || []), [a, b]]);
      entry.fineSpans = mergeSpans([...(entry.fineSpans || []), [a, b]]);
      entry.bucketVersion = BUCKET_VERSION;
      touched.add(entry);
    }
    // An open day's total must describe the same instant as its buckets, or the chart
    // runs ahead of the header: a speed test after startup put 4.95 GB in the chart
    // under a 2.99 GB header. Re-read it up to exactly `to`.
    for (const entry of touched) {
      if (entry.end <= to) continue;
      const traffic = await unifi.getTraffic(entry.start - 1, to);
      if (traffic.length) {
        entry.traffic = traffic;
        entry.coveredThrough = Math.max(entry.coveredThrough || 0, to);
      }
    }
    for (const entry of touched) {
      fitBucketsToTotals(entry);
      persistDay(entry);
    }
    console.log(`buckets ${full ? "full" : "delta"} +${rows.length} rows ${new Date(f).toISOString()}..${new Date(to).toISOString()} days=${touched.size}`);
    return { rows: rows.length };
  })();
  try {
    return await bucketRefresh;
  } catch (err) {
    lastError = err.message;
    logError("cache refreshBuckets", err);
    return { rows: 0, error: err.message };
  } finally {
    bucketRefresh = null;
  }
}

// Hourly detail and the correct total for a finished day, once. A closed day does not
// change, so this is read a single time per day (or again on "Refetch everything").
// Bumped when the history read changes, so days already read the old way are read once
// more. 2 = anchored 12 h back, recovering the early-morning hours (UU-F-048).
const HOURLY_VERSION = 2;

export async function readHourlyHistory(dayKey, { full = false } = {}) {
  const entry = days.get(dayKey);
  if (!entry?.fetchedAt || entry.end > Date.now()) return;
  if (Number(entry.hourlyRead) >= HOURLY_VERSION && !full) return;
  try {
    const { rows, blockEnd, traffic } = await fetchHourly(entry.start, entry.end);
    if (!traffic.length) {
      // UniFi no longer has this day at all; keep what we stored.
      entry.hourlyRead = HOURLY_VERSION;
      persistDay(entry);
      return;
    }
    const fine = (entry.buckets || []).filter((r) => !r[7]);
    const fineSpans = entry.fineSpans || [];
    // The hourly read of a finished day is final. 5-minute rows fetched earlier can
    // disagree with it where DPI re-labelled traffic since (Apple.com on one iPad: 3.0 MB
    // of 5-minute rows against a final 2.2 MB). So per hour and device+app, the 5-minute
    // rows are fitted to the hourly figure: topped up with a remainder row, or scaled
    // down. The day's rows then sum to its total exactly.
    const hk = (t, mac, cat, app) => `${Math.floor(t / HOUR_MS) * HOUR_MS}|${mac}|${cat}|${app}`;
    const fineBy = new Map();
    for (const r of fine) {
      const k = hk(r[0], r[1], r[3], r[2]);
      const list = fineBy.get(k);
      if (list) list.push(r);
      else fineBy.set(k, [r]);
    }
    const out = [];
    const seen = new Set();
    for (const r of rows) {
      const k = hk(r[0], r[1], r[3], r[2]);
      seen.add(k);
      const list = fineBy.get(k);
      const want = r[4] + r[5];
      if (!list) {
        out.push(r);
        continue;
      }
      const have = list.reduce((n, x) => n + x[4] + x[5], 0);
      if (have <= want) {
        for (const x of list) out.push(x);
        const rx = Math.max(0, r[4] - list.reduce((n, x) => n + x[4], 0));
        const tx = Math.max(0, want - have - rx);
        if (want - have > 0) out.push([r[0], r[1], r[2], r[3], rx, tx, 0, HOUR_MS]);
      } else {
        const f = want / have;
        for (const x of list) {
          const y = [...x];
          y[4] = Math.round(x[4] * f);
          y[5] = Math.round(x[5] * f);
          y[6] = Math.round(x[6] * f);
          if (y[4] + y[5] > 0) out.push(y);
        }
      }
    }
    // 5-minute rows the final read no longer has at all: after the early block that
    // means DPI moved them elsewhere, so they go; inside the block there is no hourly
    // figure to check against, so they stay.
    for (const [k, list] of fineBy) {
      if (seen.has(k)) continue;
      if (list[0][0] < blockEnd) for (const x of list) out.push(x);
    }
    const hourly = out.filter((r) => r[7]);
    const kept = keepLargerDay(entry.traffic, traffic);
    if (kept !== traffic) {
      console.warn(
        `hourly ${dayKey}: UniFi now reports ${trafficTotal(traffic)} bytes, stored ${trafficTotal(entry.traffic)}; keeping the stored total`
      );
    }
    entry.traffic = kept;
    entry.closedTrafficRead = true;
    // When UniFi is ageing the day out, its oldest hours are already gone: claim detail
    // only from the first hour it still has, so the missing part reads as "not placed"
    // rather than as a quiet morning.
    const detailFrom = kept !== traffic && rows.length ? Math.min(...rows.map((r) => r[0])) : blockEnd;
    entry.buckets = out.sort((x, y) => x[0] - y[0]);
    entry.bucketSpans = mergeSpans([...fineSpans, [detailFrom, entry.end]]);
    entry.hourlyRead = HOURLY_VERSION;
    fitBucketsToTotals(entry);
    persistDay(entry);
    console.log(`hourly ${dayKey} +${hourly.length} rows`);
  } catch (err) {
    lastError = err.message;
    logError("cache readHourlyHistory", err, { dayKey });
  }
}
