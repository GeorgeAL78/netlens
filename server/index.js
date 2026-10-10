import { exec } from "node:child_process";
import zlib from "node:zlib";
import readline from "node:readline";
import { pipeline } from "node:stream/promises";
import * as auth from "./auth.js";
import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appRoot, databaseDir } from "./paths.js";
import * as db from "./db.js";
import * as unifi from "./unifi.js";
import * as cache from "./cache.js";
import * as flowstore from "./flowstore.js";
import * as views from "./views.js";
import { BUCKET_MS } from "./buckets.js";
import * as siem from "./siem.js";
import * as health from "./health.js";
import * as insights from "./insights.js";
import {
  namesMatchApp,
  appMatchesFlow,
  sessionize,
  isInfrastructureDomain,
  domainFoldsIntoApp,
} from "./classify.js";
import { logError } from "./log.js";

const app = express();

// ---- Server mode (Docker, UU-C-054, UU-C-059) --------------------------------------------
// The app runs as a container with a web UI. Connection settings and the login password are
// managed in the UI (first-run setup, then Settings) and stored in the app's database.
// Environment variables only seed empty settings on first start, for scripted installs.
const SERVER_MODE = process.env.UNIFI_SERVER_MODE === "1";
const BIND = process.env.UNIFI_BIND || (SERVER_MODE ? "0.0.0.0" : "127.0.0.1");

if (process.env.SIEM_PORT && !db.getSetting("siem_port", "")) db.applyConnectionSettings({ siemPort: process.env.SIEM_PORT });
// The container listens for UniFi's syslog (ad-block counts) on 5514 by default (UU-C-079), so
// only UniFi's SIEM server needs pointing at it. Applied once: a port cleared in Settings stays off.
if (SERVER_MODE && !db.metaGet("siem_default_applied")) {
  if (!db.getSetting("siem_port", "")) db.applyConnectionSettings({ siemPort: 5514 });
  db.metaSet("siem_default_applied", "1");
}
// Forgotten password: start once with NETLENS_RESET_PASSWORD=1, then set a new one in the UI.
if (process.env.NETLENS_RESET_PASSWORD === "1" && auth.hasPassword()) {
  auth.clearPassword();
  console.warn("NETLENS_RESET_PASSWORD=1: the login password was cleared — set a new one in the UI, then remove the variable");
}
// Older installs set UI_PASSWORD in the environment; adopt it once, then the UI owns it.
if (process.env.UI_PASSWORD && !auth.hasPassword()) auth.setPassword(process.env.UI_PASSWORD);

// Container health check; deliberately before the login.
app.get("/healthz", (_req, res) => res.json({ ok: true, version: process.env.APP_VERSION || "dev" }));

// Login (UU-C-059). Until a password exists the app is open, so the first-run setup can set
// one; after that every page and API call needs the session cookie. Plain HTTP on the LAN —
// fine for a home network, not for the internet.
const OPEN_PATHS = new Set(["/healthz", "/login", "/api/login", "/api/logout"]);
app.use((req, res, next) => {
  if (!auth.hasPassword() || OPEN_PATHS.has(req.path) || auth.hasSession(req)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "login required" });
  return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
});
app.get("/login", (_req, res) => {
  res.type("html").send(auth.LOGIN_PAGE);
});
if (SERVER_MODE && !auth.hasPassword() && db.getSetting("login_disabled", "") !== "1") {
  console.warn("No login password yet: open the web UI and finish the setup to set one");
}
// UNIFI_PORT wins over the stored setting so a second instance can run alongside the
// production instance for testing without editing its saved configuration.
const port = Number(process.env.UNIFI_PORT || db.getSetting("port", process.env.PORT || 3780));
// TZ from the container (Unraid passes the server's own); otherwise the system timezone.
// `let`: the timezone can be changed in Settings without a restart (UU-C-059).
const systemTz = () => process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
let tz = db.getSetting("tz", "") || systemTz();
const snapshotMinutes = Number(db.getSetting("snapshot_minutes", process.env.SNAPSHOT_MINUTES || 5));

// origin:true reflected ANY origin, so any page the owner visited could read
// /api/settings (API key and all) and drive PUT /api/settings and POST /api/shutdown.
// The UI is same-origin in both Electron and production; vite dev runs on another
// localhost port, so allow loopback only.
const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/i;
app.use(
  cors({
    origin(origin, cb) {
      // No Origin header at all = same-origin or a non-browser client.
      if (!origin || LOOPBACK_ORIGIN.test(origin)) return cb(null, true);
      return cb(null, false);
    },
  })
);
app.use(express.json());

function sendError(res, source, err) {
  logError(source, err);
  res.status(500).json({ error: err.message });
}

const UNIDENTIFIED_APP = 65535;
const UNIDENTIFIED_CAT = 255;

// `new Date("YYYY-MM-DDT00:00:00")` parses in the OS zone, not `tz`. With the two in
// agreement that happens to be right; under TZ=UTC, midnight for "2026-09-18" resolved to
// 2026-09-17T00:00Z — the wrong calendar day. Resolve the real offset instead.
function tzOffsetMs(at) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(at)
      .map((x) => [x.type, x.value])
  );
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - at;
}

// Midnight in `tz` for a YYYY-MM-DD key, as a UTC instant. Resolved twice so a date
// whose offset changes that day (DST) still lands on the true local midnight.
function zonedMidnight(dateStr) {
  const naive = Date.parse(`${dateStr}T00:00:00Z`);
  const first = naive - tzOffsetMs(naive);
  const second = naive - tzOffsetMs(first);
  return second;
}

// Calendar arithmetic, not `± 86400000`. On 2026-11-02 (the day after DST ends) the
// old subtraction put yesterday's start at 01:00 instead of midnight.
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function zonedDateKey(ms) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

function zonedHour(ms) {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      hourCycle: "h23",
    }).format(new Date(ms))
  );
}

function rangeFor(query) {
  const now = Date.now();
  const period = query.period || "today";
  const todayKey = zonedDateKey(now);
  // A stretch inside one day — a clicked hour (UU-C-075) — drawn in 5-minute bars.
  const from = Number(query.from);
  const to = Number(query.to);
  if (Number.isFinite(from) && Number.isFinite(to) && to > from && to - from <= 86400000) {
    return { start: from, end: Math.max(from, Math.min(to, now)), grain: "5min", label: `${from}-${to}`, partial: true };
  }
  if (period === "custom" && query.date) {
    return {
      start: zonedMidnight(query.date),
      end: zonedMidnight(addDays(query.date, 1)),
      grain: "hour",
      label: query.date,
    };
  }
  if (period === "yesterday") {
    const key = addDays(todayKey, -1);
    return { start: zonedMidnight(key), end: zonedMidnight(todayKey), grain: "hour", label: key };
  }
  // Multi-day views, one bar per day. Full detail exists for the cache's 30 days; 90 days
  // reaches back through UniFi's daily per-device totals (UU-C-053, UU-C-057).
  const multi = /^(7|14|30|90)d$/.exec(period);
  if (multi) {
    const n = Number(multi[1]);
    return { start: zonedMidnight(addDays(todayKey, -(n - 1))), end: now, grain: "day", label: `last-${n}-days` };
  }
  return { start: zonedMidnight(todayKey), end: now, grain: "hour", label: todayKey };
}

// The cache stores whole local days. Every period is just a list of day keys:
// today is one, yesterday is one, 7d is seven, custom is the picked one.
function dayKeysForRange(start, end) {
  if (!(end > start)) return [];
  const keys = [];
  // Walk the calendar, so a 23- or 25-hour DST day is still exactly one key.
  let key = zonedDateKey(start);
  const lastKey = zonedDateKey(end - 1);
  for (let guard = 0; guard < 400; guard += 1) {
    keys.push(key);
    if (key === lastKey) break;
    key = addDays(key, 1);
  }
  return keys;
}

// Time UniFi had already deleted before this app saved it (UU-F-053). Worked out from
// what is cached, at report time, so existing day files need no migration:
//   * a finished day with no traffic at all: UniFi returned nothing when it was fetched
//     (Sep 24-27, after a 15-day gap);
//   * hours with time detail but zero bytes for the WHOLE network: this network is never
//     silent (the quietest hour of any complete day carried 47 MB), so an empty hour means
//     the data was gone when it was read (Sep 28 00:00-19:00);
//   * a finished day recorded only up to `coveredThrough`, outside the fetch window, so no
//     later fetch will complete it (Sep 23 after 09:22).
// Lost time is a property of the moment, not of the selection, so it is computed from the
// unfiltered buckets and is the same for every device and app.
const HOUR = 60 * 60 * 1000;

function lostSpansFor(bundle, start, end) {
  const now = Date.now();
  const oldestFetchable = addDays(zonedDateKey(now), -(FETCH_DAYS - 1));
  const covered = (a, b) =>
    bundle.bucketSpans.reduce((n, [x, y]) => n + Math.max(0, Math.min(b, y) - Math.max(a, x)), 0);
  const perHour = new Map();
  for (const r of bundle.buckets) {
    const h = Math.floor(r[0] / HOUR) * HOUR;
    perHour.set(h, (perHour.get(h) || 0) + r[4] + r[5]);
  }
  const raw = [];
  // Days with no cache file at all, from before the app ran or lost in a gap, and too old
  // to be fetched now: nothing was ever saved. Days inside the fetch window are not marked —
  // the next fetch fills them.
  const present = new Set(bundle.perDay.map((d) => d.dayKey));
  for (const dayKey of dayKeysForRange(start, Math.min(end, now))) {
    if (!present.has(dayKey) && dayKey < oldestFetchable) {
      raw.push({ from: dayStartOf(dayKey), to: dayEndOf(dayKey), dayKey, whole: true });
    }
  }
  for (const day of bundle.perDay) {
    const closed = day.end <= now;
    const dayBytes = (day.traffic || []).reduce(
      (n, c) => n + c.usage.reduce((m, u) => m + (u.totalBytes || u.bytesRx + u.bytesTx), 0),
      0
    );
    if (closed && day.fetchedAt && !dayBytes) {
      raw.push({ from: day.start, to: day.end, dayKey: day.dayKey, whole: true });
      continue;
    }
    for (let h = day.start; h + HOUR <= Math.min(day.end, now); h += HOUR) {
      if (covered(h, h + HOUR) >= HOUR && !(perHour.get(h) > 0)) raw.push({ from: h, to: h + HOUR, dayKey: day.dayKey });
    }
    if (closed && day.coveredThrough && day.coveredThrough < day.end - 5 * 60 * 1000 && day.dayKey < oldestFetchable) {
      raw.push({ from: day.coveredThrough, to: day.end, dayKey: day.dayKey });
    }
  }
  // Merge touching spans within a day.
  const out = [];
  for (const sp of raw.sort((a, b) => a.from - b.from)) {
    const last = out[out.length - 1];
    if (last && last.dayKey === sp.dayKey && sp.from <= last.to) {
      last.to = Math.max(last.to, sp.to);
      last.whole = last.whole || sp.whole || (last.from <= dayStartOf(sp.dayKey) && last.to >= dayEndOf(sp.dayKey));
    } else out.push({ ...sp });
  }
  return out
    .map((sp) => ({ ...sp, from: Math.max(sp.from, start), to: Math.min(sp.to, end) }))
    .filter((sp) => sp.to > sp.from)
    .map((sp) => ({
      ...sp,
      at: formatClock(sp.from, tz),
      endAt: formatClock(sp.to, tz),
      whole: Boolean(sp.whole) || (sp.from <= dayStartOf(sp.dayKey) && sp.to >= dayEndOf(sp.dayKey)),
    }));
}

function dayStartOf(dayKey) {
  return zonedMidnight(dayKey);
}

function dayEndOf(dayKey) {
  return zonedMidnight(addDays(dayKey, 1));
}

function dayJob(dayKey) {
  // End is the next local midnight, which is 23 h or 25 h away across a DST change.
  return { dayKey, start: zonedMidnight(dayKey), end: zonedMidnight(addDays(dayKey, 1)) };
}

// How far back we ever ask UniFi. Independent of how long days are kept on disk
// (cache.RETAIN_DAYS = 30): old days stay readable, they just stop being refreshed.
const FETCH_DAYS = 8;

// Days that fall between the oldest day we already hold and the automatic fetch
// window, with nothing cached. This is the "laptop was shut for two weeks" case: the
// normal warm only reaches back FETCH_DAYS, so the days in between stay blank unless
// the owner asks for them. Empty on a fresh install — there is no gap to fill yet.
function gapDays() {
  const todayKey = zonedDateKey(Date.now());
  const cached = cache.cachedDayKeys();
  if (!cached.length) return [];
  const retainFloor = addDays(todayKey, -(cache.RETAIN_DAYS - 1));
  const fetchFloor = addDays(todayKey, -(FETCH_DAYS - 1));
  let key = cached[0] > retainFloor ? cached[0] : retainFloor;
  const out = [];
  for (let guard = 0; guard < cache.RETAIN_DAYS + 2 && key < fetchFloor; guard += 1) {
    if (!cache.hasDay(key)) out.push(key);
    key = addDays(key, 1);
  }
  return out;
}

// Warming this span covers today, yesterday and the 7d view — they are days inside it.
function defaultCacheJobs() {
  const todayKey = zonedDateKey(Date.now());
  const keys = [];
  for (let i = FETCH_DAYS - 1; i >= 0; i -= 1) keys.push(addDays(todayKey, -i));
  return keys.map(dayJob);
}

function canonicalAppId(appId, catId, maps) {
  const id = Number(appId);
  if (!Number.isFinite(id)) return appId;
  if (id === UNIDENTIFIED_APP) return id;
  const compound = (Number(catId) << 16) + (id & 0xffff);
  if (id > 0xffff) {
    if (maps?.apps?.[id]) return id;
    if (maps?.apps?.[compound]) return compound;
    return id;
  }
  if (maps?.apps?.[compound]) return compound;
  return compound;
}

function appName(id, catId, maps) {
  if (Number(id) === UNIDENTIFIED_APP) return "Unidentified";
  if (maps.apps[id]) return maps.apps[id];
  const compound = (Number(catId) << 16) + (Number(id) & 0xffff);
  return maps.apps[compound] || `App ${id}`;
}

function catName(id, maps) {
  if (id === UNIDENTIFIED_CAT) return "Unknown";
  return maps.cats[id] || `Category ${id}`;
}

function flattenTraffic(traffic, macFilter, maps) {
  const rows = [];
  for (const item of traffic) {
    const mac = item.client.mac;
    if (macFilter && mac !== macFilter) continue;
    for (const u of item.usage) {
      rows.push({
        mac,
        name: item.client.name,
        appId: canonicalAppId(u.appId, u.catId, maps),
        catId: u.catId,
        bytesRx: u.bytesRx,
        bytesTx: u.bytesTx,
        totalBytes: u.totalBytes || u.bytesRx + u.bytesTx,
        activitySeconds: u.activitySeconds,
      });
    }
  }
  return rows;
}

// The DPI rows of a stretch inside a day, from its 5-minute (and hourly) buckets, shaped like
// flattenTraffic's. Day totals cannot be cut to an hour, so a stretch is counted from what the
// chart draws (UU-C-075).
function bucketTrafficRows(buckets, start, end, macFilter, maps, traffic) {
  const names = new Map((traffic || []).map((i) => [i.client.mac, i.client.name]));
  const rows = [];
  for (const b of buckets) {
    if (b[0] < start || b[0] >= end) continue;
    if (macFilter && b[1] !== macFilter) continue;
    rows.push({
      mac: b[1],
      name: names.get(b[1]),
      appId: canonicalAppId(b[2], b[3], maps),
      catId: b[3],
      bytesRx: b[4],
      bytesTx: b[5],
      totalBytes: b[4] + b[5],
      activitySeconds: b[6],
    });
  }
  return rows;
}

function zonedClock(ms) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
}

function filterCategory(rows, category) {
  if (!category || category === "all") return rows;
  const wanted = Number(category);
  if (Number.isNaN(wanted)) return rows;
  return rows.filter((r) => r.catId === wanted);
}

function filterApp(rows, appId, maps) {
  if (appId == null || appId === "" || appId === "all") return rows;
  const wanted = canonicalAppId(Number(appId), 0, maps);
  if (Number.isNaN(Number(wanted))) return rows;
  const wantedName = String(maps?.apps?.[wanted] || dpiAppName(wanted, maps) || "").toLowerCase();
  return rows.filter((r) => {
    const id = canonicalAppId(r.appId, r.catId, maps);
    if (id === wanted || r.appId === wanted) return true;
    if (!wantedName) return false;
    return String(appName(id, r.catId, maps)).toLowerCase() === wantedName;
  });
}

function dpiAppName(appId, maps) {
  const id = Number(appId);
  if (!Number.isFinite(id)) return "";
  return maps.apps[id] || "";
}

function flowMatchesSelectedApp(classified, appId, maps, svcName) {
  // A service we classified ourselves has no DPI id, so it is selected by name.
  if (svcName) return String(classified.app) === svcName;
  if (appId == null || appId === "" || appId === "all") return true;
  return appMatchesFlow(classified.app, dpiAppName(appId, maps));
}

function formatClock(ms, timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h12",
  }).format(new Date(ms));
}

// Newest-first slice(0, 200) hid every day but today on a 7-day map: 565 of 2,339
// sessions were from Sep 20, so the cap was all "now". Keep a hard size limit, but
// never drop a local day that still has sessions — take each day's largest first,
// then fill the rest by bytes.
const SESSION_LIMIT = 2000;

function capSessions(sessions, limit = SESSION_LIMIT) {
  const list = sessions || [];
  if (list.length <= limit) return list;
  const byDay = new Map();
  for (const s of list) {
    const key = zonedDateKey(s.start);
    const bucket = byDay.get(key);
    if (bucket) bucket.push(s);
    else byDay.set(key, [s]);
  }
  const picked = [];
  const seen = new Set();
  const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [, bucket] of days) {
    if (picked.length >= limit) break;
    bucket.sort((a, b) => b.bytes - a.bytes);
    const top = bucket[0];
    picked.push(top);
    seen.add(top);
  }
  const rest = list.filter((s) => !seen.has(s)).sort((a, b) => b.bytes - a.bytes);
  for (const s of rest) {
    if (picked.length >= limit) break;
    picked.push(s);
  }
  return picked.sort((a, b) => b.start - a.start);
}

function aggregateApps(rows, maps) {
  const byApp = new Map();
  for (const r of rows) {
    const key = canonicalAppId(r.appId, r.catId, maps);
    const cur = byApp.get(key) || {
      appId: key,
      catId: r.catId,
      bytesRx: 0,
      bytesTx: 0,
      totalBytes: 0,
      activitySeconds: 0,
    };
    cur.bytesRx += r.bytesRx;
    cur.bytesTx += r.bytesTx;
    cur.totalBytes += r.totalBytes;
    cur.activitySeconds += r.activitySeconds;
    byApp.set(key, cur);
  }
  return [...byApp.values()]
    .map((r) => ({
      ...r,
      app: appName(r.appId, r.catId, maps),
      category: catName(r.catId, maps),
    }))
    .sort((a, b) => b.totalBytes - a.totalBytes);
}

function aggregateCats(rows, maps) {
  const byCat = new Map();
  for (const r of rows) {
    const cur = byCat.get(r.catId) || { catId: r.catId, bytesRx: 0, bytesTx: 0, totalBytes: 0 };
    cur.bytesRx += r.bytesRx;
    cur.bytesTx += r.bytesTx;
    cur.totalBytes += r.totalBytes;
    byCat.set(r.catId, cur);
  }
  return [...byCat.values()]
    .map((r) => ({ ...r, category: catName(r.catId, maps) }))
    .sort((a, b) => b.totalBytes - a.totalBytes);
}

function aggregateClients(rows) {
  const byMac = new Map();
  for (const r of rows) {
    const cur = byMac.get(r.mac) || { mac: r.mac, name: r.name, totalBytes: 0, bytesRx: 0, bytesTx: 0 };
    cur.totalBytes += r.totalBytes;
    cur.bytesRx += r.bytesRx;
    cur.bytesTx += r.bytesTx;
    if (r.name) cur.name = r.name;
    byMac.set(r.mac, cur);
  }
  return [...byMac.values()].sort((a, b) => b.totalBytes - a.totalBytes);
}

async function ensureDpi() {
  const cached = db.dpiMaps();
  const last = Number(db.metaGet("dpi_at") || 0);
  if (Date.now() - last < 12 * 60 * 60 * 1000 && Object.keys(cached.apps).length > 50) {
    return cached;
  }
  const catalog = await unifi.listDpiCatalog();
  db.saveDpi(catalog.apps, catalog.cats);
  db.metaSet("dpi_at", Date.now());
  return db.dpiMaps();
}

function mergeClients(online, stored, traffic) {
  const map = new Map();
  for (const c of stored) {
    map.set(c.mac, {
      ...c,
      blocked: Boolean(c.blocked),
      online: false,
    });
  }
  for (const item of traffic) {
    const mac = item.client.mac;
    if (!mac) continue;
    const prev = map.get(mac) || { mac };
    map.set(mac, {
      ...prev,
      mac,
      name: item.client.name || prev.name,
      hostname: item.client.hostname || prev.hostname,
      type: item.client.wired ? "WIRED" : prev.type || "WIRELESS",
      online: prev.online || false,
      blocked: Boolean(prev.blocked),
    });
  }
  for (const c of online) {
    const prev = map.get(c.mac) || {};
    map.set(c.mac, { ...prev, ...c, online: true });
  }
  return [...map.values()]
    .filter((c) => c.mac)
    .sort((a, b) => String(a.name || a.mac).localeCompare(String(b.name || b.mac)));
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/clients", async (req, res) => {
  try {
    const scope = req.query.scope || "online";
    // Blocked state comes from the full client list, because a blocked device is
    // usually not associated and so is absent from the connected list. A failure here
    // must not take the whole page down — the list is still useful without it.
    const [online, maps, blockedMacs] = await Promise.all([
      unifi.listConnectedClients(),
      ensureDpi(),
      unifi.listBlockedMacs().catch((err) => {
        logError("GET /api/clients blocked", err);
        return new Set();
      }),
    ]);
    db.saveClients(online);
    let traffic = [];
    if (scope !== "online") {
      const end = Date.now();
      traffic = await unifi.getTraffic(end - 7 * 86400000, end);
      db.saveClients(
        traffic.map((t) => ({
          mac: t.client.mac,
          name: t.client.name,
          hostname: t.client.hostname,
          type: t.client.wired ? "WIRED" : "WIRELESS",
          lastSeen: Date.now(),
          blocked: false,
        }))
      );
    }
    const clients = mergeClients(online, db.listStoredClients(), traffic).map((c) => ({
      ...c,
      blocked: blockedMacs.has(String(c.mac).toLowerCase()) || Boolean(c.blocked),
    }));
    const filtered = scope === "online" ? clients.filter((c) => c.online) : clients;
    const categories = Object.entries(maps.cats)
      .map(([id, name]) => ({ id: Number(id), name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ clients: filtered, onlineCount: online.length, categories });
  } catch (err) {
    sendError(res, "GET /api/clients", err);
  }
});

// Keyed by MAC, not the Integration client id: the endpoint that can actually block
// takes a MAC (see unifi.setClientBlocked).
app.post("/api/clients/:mac/block", async (req, res) => {
  try {
    const blocked = Boolean(req.body?.blocked);
    const result = await unifi.setClientBlocked(req.params.mac, blocked);
    res.json({ ok: true, blocked: result.blocked });
  } catch (err) {
    logError("POST /api/clients/block", err);
    res.status(err.status || 500).json({ error: err.message, detail: err.body });
  }
});

app.get("/api/apps", (req, res) => {
  try {
    res.json({ apps: db.searchApps(req.query.q || "") });
  } catch (err) {
    sendError(res, "GET /api/apps", err);
  }
});

const appShell = { hide: false, quit: false };

app.get("/api/settings", (_req, res) => {
  const s = db.publicConnectionSettings();
  res.json({
    ...s,
    tz,
    hasPassword: auth.hasPassword(),
    // The owner chose to run without a login (UU-C-082).
    loginDisabled: db.getSetting("login_disabled", "") === "1",
    serverMode: SERVER_MODE,
    // First run: no API key yet, or a LAN server with neither a password nor an explicit
    // choice to run without one.
    needsSetup: !s.hasApiKey || (SERVER_MODE && !auth.hasPassword() && db.getSetting("login_disabled", "") !== "1"),
  });
});

app.post("/api/login", (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || "?";
  if (auth.lockedOut(ip)) return res.status(429).json({ error: "Too many attempts — try again in 5 minutes" });
  if (!auth.hasPassword() || !auth.checkPassword(req.body?.password)) {
    auth.recordFailure(ip);
    return res.status(401).json({ error: "Wrong password" });
  }
  auth.clearFailures(ip);
  auth.startSession(res);
  res.json({ ok: true });
});

app.post("/api/logout", (_req, res) => {
  auth.endSession(res);
  res.json({ ok: true });
});

// Set or change the login password. Changing needs the current one; setting the first one
// does not (that is the first-run setup).
app.post("/api/password", (req, res) => {
  const { current, password } = req.body || {};
  if (auth.hasPassword() && !auth.checkPassword(current)) return res.status(403).json({ error: "Current password is wrong" });
  if (String(password || "").length < 8) return res.status(400).json({ error: "Use at least 8 characters" });
  auth.setPassword(password);
  db.setSetting("login_disabled", "");
  auth.startSession(res);
  res.json({ ok: true, hasPassword: true });
});

// Run without a login (UU-C-082), chosen by the owner: in the first-run setup, or later by
// removing the password (which needs the current one). Anyone on the network can then open
// the dashboard — and block devices — so the UI says so where the choice is made.
app.post("/api/login-mode", (req, res) => {
  if (auth.hasPassword()) return res.status(409).json({ error: "Remove the password in Settings first" });
  db.setSetting("login_disabled", req.body?.disabled ? "1" : "");
  res.json({ ok: true, loginDisabled: Boolean(req.body?.disabled) });
});

app.post("/api/password/remove", (req, res) => {
  if (auth.hasPassword() && !auth.checkPassword(req.body?.current)) return res.status(403).json({ error: "Current password is wrong" });
  auth.clearPassword();
  db.setSetting("login_disabled", "1");
  auth.endSession(res);
  res.json({ ok: true, hasPassword: false, loginDisabled: true });
});

app.put("/api/settings", (req, res) => {
  try {
    const body = req.body || {};
    if (body.tz) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: body.tz });
      } catch {
        return res.status(400).json({ error: `Unknown timezone: ${body.tz}` });
      }
    }
    db.applyConnectionSettings(body);
    if (body.tz) tz = body.tz;
    db.persistConnectionFile(db.readConnectionSettings());
    siem.configure();
    res.json({ ok: true, ...db.publicConnectionSettings() });
  } catch (err) {
    sendError(res, "PUT /api/settings", err);
  }
});

app.post("/api/app/tray", (req, res) => {
  const enabled = req.body?.enabled !== false;
  db.applyConnectionSettings({ trayMode: enabled });
  if (req.body?.hide) appShell.hide = true;
  res.json({ ok: true, trayMode: enabled });
});

app.get("/api/app/poll", (_req, res) => {
  const hide = appShell.hide;
  const quit = appShell.quit;
  appShell.hide = false;
  appShell.quit = false;
  res.json({
    hide,
    quit,
    trayMode: db.getSetting("tray_mode", "0") === "1",
  });
});

app.post("/api/shutdown", (_req, res) => {
  // In a container this would stop the dashboard for everyone from any browser.
  if (SERVER_MODE) {
    res.status(403).json({ error: "Shutdown is disabled in server mode — stop the container in Unraid" });
    return;
  }
  appShell.quit = true;
  res.json({ ok: true });
  setTimeout(() => process.exit(0), 400);
});

// Gateway/WAN strip, equipment health, Wi-Fi quality, threats (UU-C-056). SQLite only —
// like /api/report, these never wait on UniFi.
app.get("/api/gateway", (_req, res) => {
  try {
    res.json({ ...insights.gatewayStatus(), poll: health.state });
  } catch (err) {
    sendError(res, "GET /api/gateway", err);
  }
});

app.get("/api/equipment", (req, res) => {
  try {
    const { start, end } = rangeFor(req.query);
    res.json({ start, end, tz, ...insights.equipment(start, end) });
  } catch (err) {
    sendError(res, "GET /api/equipment", err);
  }
});

app.get("/api/wifi", (req, res) => {
  try {
    const { start, end } = rangeFor(req.query);
    const mac = String(req.query.mac || "").toLowerCase();
    res.json({ start, end, tz, ...(mac ? insights.wifiClient(start, end, mac, tz) : { ...insights.wifiList(start, end), wired: insights.wiredList(start, end).clients }) });
  } catch (err) {
    sendError(res, "GET /api/wifi", err);
  }
});

app.get("/api/threats", (req, res) => {
  try {
    const { start, end } = rangeFor(req.query);
    res.json({ start, end, tz, ...insights.threats(start, end) });
  } catch (err) {
    sendError(res, "GET /api/threats", err);
  }
});

// ---- Views of the redesigned interface (UU-C-087), read-only like /api/report -------------
function dayContext(query) {
  const todayKey = zonedDateKey(Date.now());
  // The last N days up to now (Home's ranges, UU-C-094).
  const days = Number(query.days);
  if ([3, 7, 14, 30].includes(days)) {
    const start = zonedMidnight(addDays(todayKey, -(days - 1)));
    const now = Date.now();
    return { date: todayKey, days, today: false, bundle: cache.readDays(dayKeysForRange(start, now)), start, end: now, now };
  }
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(query.date || "")) ? String(query.date) : todayKey;
  const range = rangeFor({ period: "custom", date });
  const bundle = cache.readDays([date]);
  return { date, today: date === todayKey, bundle, start: range.start, end: range.end, now: Date.now() };
}

app.get("/api/day", (req, res) => {
  try {
    const ctx = dayContext(req.query);
    res.json({ date: ctx.date, today: ctx.today, tz, start: ctx.start, end: ctx.end, lostSpans: lostSpansFor(ctx.bundle, ctx.start, ctx.end), ...views.dayGrid(ctx) });
  } catch (err) {
    sendError(res, "GET /api/day", err);
  }
});

app.get("/api/findings", (req, res) => {
  try {
    const ctx = dayContext(req.query);
    const maps = db.dpiMaps();
    const list = views.findings({
      ...ctx,
      lostSpans: lostSpansFor(ctx.bundle, ctx.start, ctx.end),
      clock: (ms) => zonedClock(ms),
      appName: (id, cat) => appName(canonicalAppId(id, cat, maps), cat, maps),
    });
    const totals = ctx.bundle.traffic.reduce((n, c) => n + c.usage.reduce((m, u) => m + (u.totalBytes || u.bytesRx + u.bytesTx), 0), 0);
    const wan = db.latestWanSample();
    const online = db.queryClientSamples(ctx.now - 15 * 60 * 1000, ctx.now + 1, null);
    const onlineMacs = new Map();
    for (const r of online) onlineMacs.set(r.mac, r.wired);
    const blocked = insights.threats(ctx.start, ctx.end).total;
    res.json({
      date: ctx.date,
      days: ctx.days || 1,
      today: ctx.today,
      tz,
      findings: list,
      now: {
        internet: wan ? { status: wan.status, isp: wan.isp, latency: wan.latency } : null,
        online: { total: onlineMacs.size, wired: [...onlineMacs.values()].filter(Boolean).length },
        trafficBytes: totals,
        blocked,
      },
    });
  } catch (err) {
    sendError(res, "GET /api/findings", err);
  }
});

app.get("/api/network", (_req, res) => {
  try {
    const now = Date.now();
    const bundle = cache.readDays([zonedDateKey(now)]);
    res.json({ tz, ts: now, ...views.networkMap({ bundle, now }) });
  } catch (err) {
    sendError(res, "GET /api/network", err);
  }
});

// UniFi SIEM logs forwarded by syslog-ng (server/siem.js): listener status.
app.get("/api/siem", (_req, res) => {
  res.json(siem.status());
});

app.get("/api/cache", (_req, res) => {
  const todayKey = zonedDateKey(Date.now());
  res.json({
    ...cache.status(),
    gaps: gapDays(),
    retainDays: cache.RETAIN_DAYS,
    fetchDays: FETCH_DAYS,
    // Computed here because the server owns `tz`; the browser must not re-derive the
    // calendar day from its own clock (UTC slicing put the picker a day ahead).
    todayKey,
    oldestRetainedKey: addDays(todayKey, -(cache.RETAIN_DAYS - 1)),
  });
});

// Explicit opt-in to reach past FETCH_DAYS, for days missed while the app was closed.
// UniFi's own retention decides how much actually comes back.
app.post("/api/cache/backfill", async (_req, res) => {
  try {
    const gaps = gapDays();
    if (!gaps.length) {
      res.json({ ok: true, filled: 0, ...cache.status() });
      return;
    }
    await cache.warm(gaps.map(dayJob), { mode: "full" });
    res.json({ ok: true, filled: gaps.length, gaps, ...cache.status() });
  } catch (err) {
    sendError(res, "POST /api/cache/backfill", err);
  }
});

app.post("/api/cache/delta", async (req, res) => {
  try {
    const query = req.body || {};
    const jobs = defaultCacheJobs();
    // A custom date still gets its own day, but never past the FETCH_DAYS window —
    // older days stay readable from cache and are simply not refreshed.
    if (query.period) {
      const oldestFetchable = addDays(zonedDateKey(Date.now()), -(FETCH_DAYS - 1));
      const range = rangeFor(query);
      for (const dayKey of dayKeysForRange(range.start, range.end)) {
        if (dayKey < oldestFetchable) continue;
        if (!jobs.some((j) => j.dayKey === dayKey)) jobs.push(dayJob(dayKey));
      }
    }
    await cache.warm(jobs, { mode: "delta" });
    res.json({ ok: true, mode: "delta", ...cache.status() });
  } catch (err) {
    sendError(res, "POST /api/cache/delta", err);
  }
});

app.post("/api/cache/refetch", async (_req, res) => {
  try {
    await cache.warm(defaultCacheJobs(), { mode: "full" });
    res.json({ ok: true, mode: "full", ...cache.status() });
  } catch (err) {
    sendError(res, "POST /api/cache/refetch", err);
  }
});

// ---- History export / import (UU-C-066) -----------------------------------------------
//
// One gzip file of JSON lines: a header, then every saved day (with its flows), then the
// rows of the history tables. Never settings, the API key or the password. Import merges:
// a day is added when missing or replaced when the file's copy holds more traffic; table
// rows are added when missing. Nothing on the request path talks to UniFi.
const HISTORY_FORMAT = "netlens-history";

app.get("/api/history/export", async (_req, res) => {
  const gz = zlib.createGzip({ level: 6 });
  try {
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", `attachment; filename="netlens-history-${zonedDateKey(Date.now())}.ndjson.gz"`);
    gz.pipe(res);
    const write = (obj) =>
      new Promise((resolve) => {
        if (gz.write(`${JSON.stringify(obj)}\n`)) resolve();
        else gz.once("drain", resolve);
      });
    await write({ format: HISTORY_FORMAT, version: 1, exportedAt: Date.now(), app: process.env.APP_VERSION || "dev", tz });
    let dayCount = 0;
    for (const day of cache.exportDays()) {
      await write({ type: "day", day });
      // A busy day has 150k+ flows: written in chunks so neither side holds it whole.
      if (day.flowsFollow) {
        for (const rows of flowstore.iterDay(day.dayKey)) await write({ type: "flows", dayKey: day.dayKey, rows });
      }
      dayCount += 1;
    }
    for (const table of db.HISTORY_TABLES) {
      for (const rows of db.exportTable(table)) await write({ type: "rows", table, rows });
    }
    gz.end();
    console.log(`history export: ${dayCount} day(s)`);
  } catch (err) {
    if (!res.headersSent) return sendError(res, "GET /api/history/export", err);
    logError("GET /api/history/export", err);
    res.destroy(err);
  }
});

app.post("/api/history/import", async (req, res) => {
  const tmp = path.join(databaseDir, `import-${Date.now()}.tmp`);
  try {
    await pipeline(req, fs.createWriteStream(tmp));
    const head = Buffer.alloc(2);
    const fd = fs.openSync(tmp, "r");
    fs.readSync(fd, head, 0, 2, 0);
    fs.closeSync(fd);
    const gzipped = head[0] === 0x1f && head[1] === 0x8b;
    const source = fs.createReadStream(tmp);
    const lines = readline.createInterface({ input: gzipped ? source.pipe(zlib.createGunzip()) : source, crlfDelay: Infinity });
    const days = { added: 0, replaced: 0, kept: 0, old: 0, busy: 0, bad: 0 };
    const rows = {};
    let header = null;
    // A day whose flows follow as chunks is held until its last chunk, then imported. Days
    // that will be kept or skipped do not collect their chunks at all.
    let held = null;
    const flush = () => {
      if (!held) return;
      days[held.take ? cache.importDay(held.day) : held.verdict] += 1;
      held = null;
    };
    for await (const line of lines) {
      if (!line.trim()) continue;
      const obj = JSON.parse(line);
      if (!header) {
        if (obj?.format !== HISTORY_FORMAT) {
          res.status(400).json({ error: "This is not a NetLens history file." });
          lines.close();
          source.destroy();
          return;
        }
        header = obj;
        continue;
      }
      if (obj.type === "flows") {
        if (held?.take && held.day.dayKey === obj.dayKey) for (const r of obj.rows || []) held.day.flows.push(r);
        continue;
      }
      flush();
      if (obj.type === "day") {
        const verdict = cache.importVerdict(obj.day);
        const take = verdict === "added" || verdict === "replaced";
        if (obj.day && obj.day.flowsFollow) obj.day.flows = [];
        held = { day: obj.day, verdict, take };
      } else if (obj.type === "rows") {
        rows[obj.table] = (rows[obj.table] || 0) + db.importRows(obj.table, obj.rows);
      }
    }
    flush();
    if (!header) return res.status(400).json({ error: "The file is empty." });
    console.log(`history import: days ${JSON.stringify(days)} rows ${JSON.stringify(rows)}`);
    res.json({ ok: true, exportedAt: header.exportedAt || null, days, rows, retainDays: cache.RETAIN_DAYS });
  } catch (err) {
    sendError(res, "POST /api/history/import", err);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

app.post("/api/log", (req, res) => {
  const body = req.body || {};
  logError(body.source || "ui", body.stack || body.message || "unknown", body.extra);
  res.json({ ok: true });
});

app.get("/api/report", async (req, res) => {
  try {
    const mac = (req.query.mac || "").toLowerCase();
    const category = req.query.category || "all";
    const rawAppId = String(req.query.appId || "all");
    // Two kinds of selection: a UniFi DPI application id, or "svc:<name>" for a service
    // only our own flow classification knows about (steamcontent.com, real-debrid.com).
    const svcName = rawAppId.startsWith("svc:") ? rawAppId.slice(4) : null;
    const appId = svcName ? "all" : rawAppId;
    const appSelected = rawAppId !== "all";
    const range = rangeFor(req.query);
    const { start, end, grain } = range;
    // db.dpiMaps(), not ensureDpi(): the latter calls unifi.listDpiCatalog() when the
    // local catalog is >12 h old, which would make a report request hit the console
    // (REVIEW rule 2/8). The catalog is refreshed by snapshot() and /api/clients, both
    // of which already talk to UniFi. A cold, empty catalog just degrades app names.
    const maps = db.dpiMaps();
    const bundle = cache.readDays(dayKeysForRange(start, end));
    const live = bundle.traffic;
    // Flows are queried from flows.db per need (UU-C-062), never loaded whole.
    const flowDays = bundle.flowDays;
    let rows = range.partial
      ? bucketTrafficRows(bundle.buckets, start, end, mac || null, maps, live)
      : flattenTraffic(live, mac || null, maps);
    // Flow queries for a stretch inside the days only see that stretch.
    const span = range.partial ? { from: start, to: end } : undefined;

    // ONE SOURCE PER SCREEN (UU-C-043). Every number on the page comes from the same
    // basis, so they add up by construction instead of by luck:
    //   "dpi"   — a UniFi application (or all apps). Header, Apps table, categories and
    //             devices from DPI day totals; the chart and sessions from 5-minute DPI
    //             buckets of the same counters. Flow records only name destinations.
    //   "flows" — a service only our classifier knows (svc:<name>). Everything from the
    //             flow records matched to it.
    // The old design picked the app from DPI and drew the chart from flows matched by
    // name. Audited over the whole cache, 384 of 461 device/app/day selections with
    // >= 20 MB drew an empty chart that way.
    const basis = svcName ? "flows" : "dpi";
    const scopedRows = filterCategory(rows, category);
    rows = filterApp(scopedRows, appId, maps);

    const step = grain === "5min" ? BUCKET_MS : grain === "hour" ? 3600000 : 86400000;
    const now = Date.now();
    // Where 5-minute detail exists. Outside these spans the day's total is known but not
    // when it happened, and the chart says so instead of drawing zero.
    // 5-minute bars count only real 5-minute detail; hours UniFi kept as one total are not
    // "detail" at that scale (UU-C-075).
    const spans = (grain === "5min" ? bundle.fineSpans : bundle.bucketSpans)
      .map(([a, b]) => [Math.max(a, start), Math.min(b, end)])
      .filter(([a, b]) => b > a)
      .sort((x, y) => x[0] - y[0]);
    const coveredMs = (a, b) =>
      spans.reduce((n, [x, y]) => n + Math.max(0, Math.min(b, y) - Math.max(a, x)), 0);
    const timelineMap = new Map();
    for (let t = start; t < end; t += step) {
      const until = Math.min(t + step, now);
      timelineMap.set(t, {
        t,
        label: grain === "hour" ? `${String(zonedHour(t)).padStart(2, "0")}:00` : grain === "5min" ? zonedClock(t) : zonedDateKey(t),
        totalBytes: 0,
        // Share of this bar's time that has 5-minute detail, 0..1. Daily bars come from
        // day totals and flow screens from flow timestamps, so both are always whole.
        coverage:
          grain === "day" || basis === "flows" || until <= t ? 1 : Math.min(1, coveredMs(t, until) / (until - t)),
      });
    }
    const place = (t, bytes) => {
      const bucket = timelineMap.get(start + Math.floor(Math.max(0, t - start) / step) * step);
      if (bucket) bucket.totalBytes += bytes;
    };

    const deviceNames = new Map();
    for (const item of live) {
      if (item.client?.mac) deviceNames.set(item.client.mac, item.client.name || item.client.mac);
    }
    // Local destinations UniFi only knows by MAC or IP (UU-F-052) get a name from the
    // stored client list, or from the SIEM events (aliases such as Unraid containers, and
    // the switch/AP/gateway names). Report-time only: the cache keeps the raw address.
    const localName = (() => {
      const byMac = new Map();
      const byIp = new Map();
      // UniFi gives an unnamed client its MAC as the name; that is not a name.
      const real = (n) => (n && !/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(String(n).trim()) ? n : null);
      for (const c of db.listStoredClients()) {
        const n = real(c.name) || real(c.hostname);
        if (!n) continue;
        if (c.mac) byMac.set(String(c.mac).toLowerCase(), n);
        if (c.ip) byIp.set(c.ip, n);
      }
      for (const [m, n] of db.siemNamesByMac()) if (!byMac.has(m) && real(n)) byMac.set(m, n);
      // Then UniFi's own devices (every interface) and known, also offline, clients.
      const saved = db.localNames();
      return (domain) => {
        const d = String(domain || "").toLowerCase();
        const n = byMac.get(d) || byIp.get(d) || real(saved.get(d));
        if (n) return n;
        // No name anywhere: the address itself, so each device is its own row instead of
        // one anonymous "Local network" bucket (owner: "if no name just report it as mac").
        return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(d) || /^\d{1,3}(\.\d{1,3}){3}$/.test(d) || /^[0-9a-f:]+:[0-9a-f:]*$/.test(d) ? d : null;
      };
    })();
    const named = (row) => {
      if (row.app !== "Local network") return row;
      const n = localName(row.domain);
      return n ? { ...row, app: n } : row;
    };
    // Per day x app x device byte sums, in first-seen order, with local names applied.
    const flowGroups = (span ? flowstore.groupsInRange(flowDays, mac || null, span.from, span.to) : flowstore.groups(flowDays, mac || null)).map((g) => ({
      ...g,
      app: g.app === "Local network" ? localName(g.ldomain) || g.app : g.app,
      rawApp: g.app,
    }));
    // The selection as a database filter: the stored app names, and the "Local network"
    // destinations, whose (named) app matches. null = everything.
    const selectedFilter = (() => {
      if (!svcName && (appId == null || appId === "" || appId === "all")) return null;
      const apps = new Set();
      const localDomains = new Set();
      for (const g of flowGroups) {
        if (!flowMatchesSelectedApp(g, appId, maps, svcName)) continue;
        if (g.rawApp === "Local network") localDomains.add(g.ldomain);
        else apps.add(g.rawApp);
      }
      return { apps: [...apps], localDomains: [...localDomains] };
    })();
    // Only a flow screen needs the matched rows themselves; a DPI screen only shows the
    // newest few as activity.
    const matchedFlows =
      basis === "flows"
        ? flowstore.rowsForApps(flowDays, mac || null, selectedFilter.apps, selectedFilter.localDomains, span).map(named)
        : [];

    // What a device talked to during a session, from flows.db by device and time.
    const destinationsFor = (s) => {
      // Ranked by bytes, not by whether the name looks like the app. Preferring
      // name-matches put apple-dns.net (a few KB) ahead of the 570 MB that actually went
      // to aaplimg.com during an App Store download — the same name-matching trap this
      // redesign removes. These are what the device talked to at the time, labelled so.
      const top = flowstore.destinations(flowDays, s.mac, s.start - BUCKET_MS, s.end, 3);
      return { domains: top.domains, domainsBasis: top.any ? "device" : null };
    };

    const SESSION_GAP = 10 * 60 * 1000;
    // Listed individually above this; the rest is summarised so the list still adds up.
    const SESSION_LIST_MIN = 1024 * 1024;
    let totals;
    let chartBytes = 0;
    let rawSessions = [];
    let trickle = [];
    let apps;
    let categories;
    let clients;

    if (basis === "dpi") {
      totals = {
        bytes: rows.reduce((s, r) => s + r.totalBytes, 0),
        rx: rows.reduce((s, r) => s + r.bytesRx, 0),
        tx: rows.reduce((s, r) => s + r.bytesTx, 0),
        source: "dpi",
      };
      const bucketRows = [];
      for (const b of bundle.buckets) {
        if (b[0] < start || b[0] >= end) continue;
        if (mac && b[1] !== mac) continue;
        const id = canonicalAppId(b[2], b[3], maps);
        bucketRows.push({
          t: b[0],
          tEnd: b[0] + (b[7] || BUCKET_MS),
          mac: b[1],
          appId: id,
          catId: b[3],
          app: appName(id, b[3], maps),
          category: catName(b[3], maps),
          bytesRx: b[4],
          bytesTx: b[5],
          totalBytes: b[4] + b[5],
          bytes: b[4] + b[5],
          activitySeconds: b[6],
        });
      }
      const selBuckets = filterApp(filterCategory(bucketRows, category), appId, maps);
      if (grain === "day") {
        for (const day of bundle.perDay) {
          const dayRows = filterApp(
            filterCategory(flattenTraffic(day.traffic, mac || null, maps), category),
            appId,
            maps
          );
          const bytes = dayRows.reduce((n, r) => n + r.totalBytes, 0);
          place(Math.max(day.start, start), bytes);
          chartBytes += bytes;
        }
      } else {
        for (const r of selBuckets) {
          // In 5-minute bars an hourly row (an hour UniFi only kept as one total) has no place:
          // it stays in the header and is reported as not drawn, never spread into fake detail.
          if (grain === "5min" && r.tEnd - r.t > step) continue;
          place(r.t, r.bytes);
          chartBytes += r.bytes;
        }
      }
      // Background chatter (a few KB every few minutes) must not hold a session open: a
      // 40-minute App Store download read as "1h 55m" because of 80 KB of keep-alives.
      // Those buckets are left out of session boundaries but still counted, as bursts.
      const TRICKLE = 64 * 1024;
      trickle = selBuckets.filter((r) => r.bytes < TRICKLE);
      rawSessions = sessionize(
        selBuckets.filter((r) => r.bytes >= TRICKLE),
        { gapMs: SESSION_GAP, minBytes: 0, keyBy: "mac+app" }
      ).map((s) => ({
        ...s,
        activeSeconds: s.rows.reduce((n, r) => n + r.activitySeconds, 0),
        flowCount: null,
        source: "dpi",
      }));
      apps = aggregateApps(rows, maps);
      const devicesByApp = new Map();
      for (const r of rows) {
        const key = canonicalAppId(r.appId, r.catId, maps);
        const byMac = devicesByApp.get(key) || new Map();
        byMac.set(r.mac, (byMac.get(r.mac) || 0) + r.totalBytes);
        devicesByApp.set(key, byMac);
      }
      for (const a of apps) {
        const byMac = devicesByApp.get(a.appId);
        a.topDevices = byMac
          ? [...byMac.entries()]
              .sort((x, y) => y[1] - x[1])
              .slice(0, 3)
              .map(([m, b]) => ({ name: deviceNames.get(m) || m, bytes: b }))
          : [];
      }
      categories = aggregateCats(rows, maps);
      clients = aggregateClients(rows);
    } else {
      totals = {
        bytes: matchedFlows.reduce((n, r) => n + r.bytes, 0),
        rx: matchedFlows.reduce((n, r) => n + Number(r.bytesRx || 0), 0),
        tx: matchedFlows.reduce((n, r) => n + Number(r.bytesTx || 0), 0),
        source: "flows",
      };
      for (const r of matchedFlows) {
        if (!r.t) continue;
        place(r.t, r.bytes);
        chartBytes += r.bytes;
      }
      rawSessions = sessionize(matchedFlows, { gapMs: SESSION_GAP, minBytes: 0, keyBy: "mac+app" }).map((s) => ({
        ...s,
        activeSeconds: null,
        source: "flows",
        domainsBasis: "app",
      }));
      const macs = new Map();
      for (const r of matchedFlows) {
        const m = macs.get(r.mac) || {
          mac: r.mac,
          name: deviceNames.get(r.mac) || r.mac,
          totalBytes: 0,
          bytesRx: 0,
          bytesTx: 0,
        };
        m.totalBytes += r.bytes;
        m.bytesRx += Number(r.bytesRx || 0);
        m.bytesTx += Number(r.bytesTx || 0);
        macs.set(r.mac, m);
      }
      clients = [...macs.values()].sort((a, b) => b.totalBytes - a.totalBytes);
      const category0 = matchedFlows[0]?.category || "Unknown";
      apps = totals.bytes
        ? [
            {
              appId: rawAppId,
              app: svcName,
              category: category0,
              totalBytes: totals.bytes,
              bytesRx: totals.rx,
              bytesTx: totals.tx,
              activitySeconds: null,
              source: "flows",
              topDevices: clients.slice(0, 3).map((c) => ({ name: c.name, bytes: c.totalBytes })),
            },
          ]
        : [];
      categories = totals.bytes
        ? [{ catId: null, category: category0, totalBytes: totals.bytes, bytesRx: totals.rx, bytesTx: totals.tx }]
        : [];
    }
    const lostSpans = lostSpansFor(bundle, start, end);

    // Missing days filled from UniFi's daily per-device report (UU-C-057): a whole lost day
    // gets the device's daily total, a partly lost day only what the daily total has beyond
    // what was saved. Device totals only — no apps, no hours — so never when an app or a
    // category is selected, and never added to `totals` / `timeline`: they travel as
    // `dailyFill` and are drawn apart.
    const dailyFill = { days: [], totalBytes: 0, devices: [] };
    if (basis === "dpi" && !range.partial && !appSelected && (!category || category === "all") && lostSpans.length) {
      const keys = dayKeysForRange(start, Math.min(end, now));
      const rowsDaily = keys.length ? db.queryDailyDevice(keys[0], keys[keys.length - 1], mac || null) : [];
      const dailyBy = new Map();
      for (const r of rowsDaily) {
        const m = dailyBy.get(r.day) || new Map();
        m.set(r.mac, (r.rx || 0) + (r.tx || 0));
        dailyBy.set(r.day, m);
      }
      const savedBy = new Map();
      for (const day of bundle.perDay) {
        const m = new Map();
        for (const c of day.traffic || []) {
          if (mac && c.client.mac !== mac) continue;
          m.set(c.client.mac, c.usage.reduce((n, u) => n + (u.totalBytes || u.bytesRx + u.bytesTx), 0));
        }
        savedBy.set(day.dayKey, m);
      }
      const storedNames = new Map(db.listStoredClients().map((c) => [String(c.mac).toLowerCase(), c.name || c.hostname]));
      const perDevice = new Map();
      const lostDays = new Map();
      for (const sp of lostSpans) lostDays.set(sp.dayKey, (lostDays.get(sp.dayKey) || false) || sp.whole);
      for (const [dayKey, whole] of lostDays) {
        const daily = dailyBy.get(dayKey);
        if (!daily) continue;
        const saved = savedBy.get(dayKey) || new Map();
        let bytes = 0;
        let devices = 0;
        for (const [m, b] of daily) {
          const add = whole ? b : Math.max(0, b - (saved.get(m) || 0));
          if (add <= 0) continue;
          bytes += add;
          devices += 1;
          perDevice.set(m, (perDevice.get(m) || 0) + add);
        }
        if (!bytes) continue;
        dailyFill.days.push({ dayKey, t: Math.max(dayStartOf(dayKey), start), bytes, devices, whole });
        dailyFill.totalBytes += bytes;
      }
      dailyFill.devices = [...perDevice.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([m, b]) => ({ mac: m, name: deviceNames.get(m) || storedNames.get(m) || m, bytes: b }));
      const filled = new Set(dailyFill.days.map((d) => d.dayKey));
      for (const sp of lostSpans) sp.filled = filled.has(sp.dayKey);
      if (grain === "day") {
        for (const d of dailyFill.days) {
          const b = timelineMap.get(start + Math.floor(Math.max(0, d.t - start) / step) * step);
          if (b) b.fillBytes = (b.fillBytes || 0) + d.bytes;
        }
      }
    }
    for (const b of timelineMap.values()) {
      const bEnd = b.t + step;
      const lostMs = lostSpans.reduce((n, sp) => n + Math.max(0, Math.min(bEnd, sp.to) - Math.max(b.t, sp.from)), 0);
      // Share of this bar's time that UniFi had deleted before it was saved, 0..1. Such
      // time is never "detail": it is reported as lost, not as a quiet stretch.
      b.lost = Math.min(1, lostMs / step);
      if (grain !== "day" && b.lost > 0) b.coverage = Math.max(0, Math.min(b.coverage, 1 - b.lost));
    }
    const timeline = [...timelineMap.values()];
    // What the header counts but the chart could not place in time: the part of a day
    // older than UniFi's ~24 h of 5-minute detail, from before the app was running.
    // Shown, never hidden, so chart + unplaced = header.
    const unplacedBytes = Math.max(0, totals.bytes - chartBytes);

    // Time in use (UU-C-108): every session of the selection merged on the clock, so two
    // overlapping sessions count once. Background trickle never opens a session.
    let inUseMs = 0;
    {
      let cur = null;
      for (const s of [...rawSessions].sort((a, b) => a.start - b.start)) {
        if (cur && s.start <= cur.end) cur.end = Math.max(cur.end, s.end);
        else {
          if (cur) inUseMs += cur.end - cur.start;
          cur = { start: s.start, end: s.end };
        }
      }
      if (cur) inUseMs += cur.end - cur.start;
    }
    const listed = rawSessions.filter((s) => s.bytes >= SESSION_LIST_MIN);
    const small = rawSessions.filter((s) => s.bytes < SESSION_LIST_MIN);
    const sessionCount = listed.length;
    // Destinations only for the sessions actually listed: one indexed query each.
    const sessions = capSessions(listed).map((s) => (s.source === "dpi" ? { ...s, ...destinationsFor(s) } : s)).map((s) => ({
      app: s.app,
      category: s.category,
      mac: s.mac,
      device: deviceNames.get(s.mac) || s.mac || "unknown",
      start: s.start,
      end: s.end,
      at: formatClock(s.start, tz),
      endAt: formatClock(s.end, tz),
      durationMs: s.durationMs,
      activeSeconds: s.activeSeconds,
      bytes: s.bytes,
      flowCount: s.flowCount,
      domains: s.domains,
      domainsBasis: s.domainsBasis,
      source: s.source,
    }));
    const listedBytes = listed.reduce((n, s) => n + s.bytes, 0);
    const shownBytes = sessions.reduce((n, s) => n + s.bytes, 0);
    const sessionsOmitted = {
      count: small.length + (listed.length - sessions.length) + trickle.length,
      bytes:
        small.reduce((n, s) => n + s.bytes, 0) + (listedBytes - shownBytes) + trickle.reduce((n, r) => n + r.bytes, 0),
    };

    const activity = flowstore
      .latest(flowDays, mac || null, selectedFilter, 80, span)
      .map(named)
      .map((row) => ({
        t: row.t,
        at: formatClock(row.t, tz),
        app: row.app,
        category: row.category,
        domain: row.domain,
        service: row.service,
        action: row.action,
        bytes: row.bytes,
        kind: row.kind,
      }));

    // Traffic that never left the network. UniFi's DPI counters cover internet traffic
    // only — a TV streaming from a home media server showed 9.8 GB of DPI against 133 GB — so
    // this comes from flow records and is reported on its own. It is deliberately NOT
    // added to `totals`, `apps`, `categories` or `clients`: those stay exactly UniFi's
    // numbers, and mixing the two sources is what UU-C-043 removed (UU-F-051).
    const localByApp = new Map();
    let localBytes = 0;
    for (const row of flowGroups) {
      if (row.category !== "Local network") continue;
      localBytes += row.bytes;
      const cur = localByApp.get(row.app) || { app: row.app, bytes: 0, byMac: new Map() };
      cur.bytes += row.bytes;
      cur.byMac.set(row.mac, (cur.byMac.get(row.mac) || 0) + row.bytes);
      localByApp.set(row.app, cur);
    }
    const localServices = [...localByApp.values()]
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 12)
      .map((l) => {
        const top = [...l.byMac.entries()].sort((a, b) => b[1] - a[1])[0];
        return {
          app: l.app,
          value: `svc:${l.app}`,
          bytes: l.bytes,
          topDevice: top ? deviceNames.get(top[0]) || top[0] : null,
          deviceCount: l.byMac.size,
        };
      });

    // UniFi's SIEM events (UU-C-050), read from SQLite — never from syslog-ng or UniFi on
    // the request path. Events about a device, plus ad-block hits; no traffic volume.
    const siemRows = db.querySiemEvents(start, end, mac || null);
    // The pulled System Log ("log") is the primary source. Syslog CEF events describe the
    // same things, so they are only used for a range the System Log has nothing for.
    const eventKind = siemRows.some((e) => e.kind === "log") ? "log" : "cef";
    const siemEvents = siemRows
      .filter((e) => e.kind === eventKind)
      .slice(0, 200)
      .map((e) => {
        const d = e.data || {};
        return {
          ts: e.ts,
          at: formatClock(e.ts, tz),
          name: e.name,
          category: e.category,
          severity: d.severity ?? null,
          mac: e.mac,
          device: d.clientAlias || deviceNames.get(e.mac) || d.clientHostname || e.mac || null,
          via:
            d.via ||
            (d.lastConnectedToDeviceName
              ? `${d.lastConnectedToDeviceName}${d.lastConnectedToDevicePort ? ` port ${d.lastConnectedToDevicePort}` : ""}`
              : d.apName || d.deviceName || null),
          duration: d.duration || null,
          usageDown: d.usageDown || null,
          usageUp: d.usageUp || null,
          msg: d.msg || null,
        };
      });
    const adRows = siemRows.filter((e) => e.kind === "dns");
    const countBy = (rows, key) => {
      const m = new Map();
      for (const r of rows) {
        const k = key(r);
        if (k) m.set(k, (m.get(k) || 0) + 1);
      }
      return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => ({ name, count }));
    };
    const siemSummary = {
      configured: true,
      events: siemEvents,
      eventCount: siemRows.filter((e) => e.kind === eventKind).length,
      adBlocks: {
        count: adRows.length,
        topDomains: countBy(adRows, (r) => r.data?.domain),
        topDevices: mac ? [] : countBy(adRows, (r) => deviceNames.get(r.mac) || r.mac),
      },
    };

    // App picker: UniFi's applications, plus services only our classifier names. A
    // detected service that is really a DPI app's own CDN (crunchyrollcdn.com) is hidden
    // behind that app rather than listed twice — but its bytes are NOT added to the DPI
    // figure any more; that mixing is what put 4.69 GB beside a 131.8 MB app.
    const choiceByKey = new Map();
    const normName = (n) => String(n || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    for (const a of aggregateApps(scopedRows, maps)) {
      choiceByKey.set(normName(a.app), { value: String(a.appId), app: a.app, category: a.category, totalBytes: a.totalBytes, source: "unifi" });
    }
    const detected = new Map();
    for (const row of flowGroups) {
      if (!row.app || row.app === "Unidentified" || row.app === "DNS" || row.app === "Local network") continue; // "Local network" is the unnamed bucket; named LAN hosts pass
      detected.set(row.app, (detected.get(row.app) || 0) + Number(row.bytes || 0));
    }
    for (const [name, bytes] of detected) {
      const key = normName(name);
      if (choiceByKey.has(key)) continue;
      if (localByApp.has(name)) {
        // A LAN service cannot be a DPI app, so it is never folded into one.
        choiceByKey.set(key, { value: `svc:${name}`, app: name, totalBytes: bytes, source: "local" });
        continue;
      }
      if ([...choiceByKey.values()].some((c) => c.source === "unifi" && domainFoldsIntoApp(name, c.app))) continue;
      choiceByKey.set(key, {
        value: `svc:${name}`,
        app: name,
        totalBytes: bytes,
        source: "detected",
        infrastructure: isInfrastructureDomain(name),
      });
    }
    const APP_CHOICE_MIN_BYTES = 1024 * 1024;
    const APP_CHOICE_LIMIT = 60;
    const appChoices = [...choiceByKey.values()]
      .filter((a) => a.totalBytes >= APP_CHOICE_MIN_BYTES)
      .sort((a, b) => b.totalBytes - a.totalBytes)
      .slice(0, APP_CHOICE_LIMIT);

    res.json({
      start,
      end,
      grain,
      // A stretch inside a day: everything on it comes from its 5-minute rows (UU-C-075).
      partial: Boolean(range.partial),
      tz,
      appId: appSelected ? rawAppId : null,
      basis,
      source: bundle.fetchedAt ? "cache" : "empty",
      cachedAt: bundle.fetchedAt || null,
      missingDays: bundle.missingDays,
      totals,
      // Flow-derived and reported apart from `totals`, which stays UniFi's own count.
      localBytes: basis === "flows" ? 0 : localBytes,
      localServices: basis === "flows" ? [] : localServices,
      unplacedBytes,
      lostSpans,
      dailyFill,
      siem: siemSummary,
      // Share of the range with 5-minute detail, 0..1.
      detailCoverage:
        grain === "day" || basis === "flows"
          ? 1
          : Math.max(
              0,
              coveredMs(start, Math.min(end, now)) -
                lostSpans.reduce((n, sp) => n + Math.max(0, Math.min(sp.to, end, now) - Math.max(sp.from, start)), 0)
            ) / Math.max(1, Math.min(end, now) - start),
      timeline,
      activity,
      sessions,
      sessionCount,
      sessionsOmitted,
      time: { inUseMs, sessions: rawSessions.length },
      apps,
      appChoices,
      categories,
      clients,
    });
  } catch (err) {
    sendError(res, "GET /api/report", err);
  }
});

async function snapshot() {
  try {
    const end = Date.now();
    const start = end - snapshotMinutes * 60 * 1000;
    const [online, traffic] = await Promise.all([
      unifi.listConnectedClients(),
      unifi.getTraffic(start, end),
      ensureDpi(),
    ]);
    db.saveClients(online);
    // Names only. The byte counts in a trailing 5-minute window are not usable: the
    // endpoint drops whatever sits on a window edge, so these samples under-counted and
    // were never comparable to the day totals. Time detail now comes from
    // cache.refreshBuckets (UU-C-043).
    for (const item of traffic) {
      db.saveClients([
        {
          mac: item.client.mac,
          name: item.client.name,
          hostname: item.client.hostname,
          type: item.client.wired ? "WIRED" : "WIRELESS",
          lastSeen: end,
          blocked: false,
        },
      ]);
    }
    const { rows } = await cache.refreshBuckets();
    // UniFi's System Log: connects, disconnects, roams, threats (UU-C-051).
    await siem.refreshSystemLog().catch((err) => logError("siem refreshSystemLog", err));
    // Live Wi-Fi quality, equipment health and WAN state (UU-C-056).
    await health.pollHealth().catch((err) => logError("health pollHealth", err));
    // UniFi's per-device daily totals: fills lost days, 90+ days of history (UU-C-057).
    await health.refreshDaily(zonedDateKey).catch((err) => logError("health refreshDaily", err));
    await health.refreshLocalNames().catch((err) => logError("health refreshLocalNames", err));
    await health.refreshIpsDetails().catch((err) => logError("health refreshIpsDetails", err));
    db.metaSet("last_snapshot", end);
    console.log(`snapshot ${new Date(end).toISOString()} clients=${online.length} buckets=+${rows}`);
  } catch (err) {
    logError("snapshot", err);
  }
}

const dist = path.join(appRoot, "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  // v2 is a second release served from the same build: /v2 gets its own entry, and the
  // catch-all below must not swallow it or deep links would render the classic view.
  app.get(/^\/v2(\/.*)?$/, (_req, res) => {
    res.sendFile(path.join(dist, "v2", "index.html"));
  });
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(dist, "index.html"));
  });
}

const url = `http://${BIND === "0.0.0.0" ? "127.0.0.1" : BIND}:${port}`;

function launchBrowser() {
  if (process.platform === "win32") exec(`cmd /c start "" "${url}"`);
  else exec(`xdg-open "${url}"`);
}

let snapshotTimer = null;
let httpServer = null;

export function startHttpServer({ openBrowser = false } = {}) {
  return new Promise((resolve, reject) => {
    if (httpServer?.listening) {
      resolve({ url, port, alreadyRunning: true, close: closeHttpServer });
      return;
    }
    httpServer = app.listen(port, BIND, () => {
      console.log(`NetLens on ${url}${BIND === "0.0.0.0" ? ` (listening on all interfaces, port ${port})` : ""}`);
      console.log(`Database: ${databaseDir}`);
      // NETLENS_OFFLINE=1: serve the stored data without ever talking to UniFi — used to
      // compare report output before and after a change on a frozen copy (UU-C-060).
      const offline = process.env.NETLENS_OFFLINE === "1";
      if (!offline) snapshot();
      if (!offline && !snapshotTimer) snapshotTimer = setInterval(snapshot, snapshotMinutes * 60 * 1000);
      // SIEM logs forwarded by syslog-ng (UU-C-050): listen if a port is set.
      siem.configure();
      if (!offline) {
        cache
          .warm(defaultCacheJobs(), { mode: "delta" })
          .catch((err) => logError("cache warmup", err));
      }
      if (openBrowser) launchBrowser();
      resolve({ url, port, alreadyRunning: false, close: closeHttpServer });
    });
    httpServer.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        console.log(`Already running at ${url}`);
        // The listen callback can win the race and fire before this does, so this
        // process may already have started the snapshot timer and a cache warm.
        // Leaving it alive produced a headless twin that polled UniFi every 5 min and
        // wrote usage_samples while serving nothing. Stop the work, then step aside.
        if (snapshotTimer) {
          clearInterval(snapshotTimer);
          snapshotTimer = null;
        }
        resolve({ url, port, alreadyRunning: true, close: closeHttpServer });
        if (launchedDirectly) setTimeout(() => process.exit(0), 50);
        return;
      }
      reject(err);
    });
  });
}

export function closeHttpServer() {
  return new Promise((resolve) => {
    if (snapshotTimer) {
      clearInterval(snapshotTimer);
      snapshotTimer = null;
    }
    if (!httpServer) {
      resolve();
      return;
    }
    httpServer.close(() => resolve());
    httpServer = null;
  });
}

process.on("uncaughtException", (err) => logError("uncaughtException", err));
process.on("unhandledRejection", (err) => logError("unhandledRejection", err));

const launchedDirectly =
  Boolean(process.argv[1]) && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (launchedDirectly) {
  startHttpServer({
    openBrowser: process.argv.includes("--open") || process.env.UNIFI_OPEN_BROWSER === "1",
  }).catch((err) => {
    logError("server start", err);
    process.exit(1);
  });
}
