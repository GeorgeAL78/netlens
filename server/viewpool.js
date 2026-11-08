// Pages built off the main thread (UU-C-210). Node answers one request at a time, so a 30-day
// Overview that took 8.8 s on the owner's N100 also held up every click and the 5-minute
// update behind it. A few worker threads each run NetLens in view mode (role.js): the same
// code, read-only databases, no timers, no UniFi, listening on 127.0.0.1 only. The main thread
// sends the read-only pages there and stays free.
//
// Each request carries the main thread's data version; a worker that is behind re-reads what
// changed before answering. Requests need a secret made at start, so nothing else on the host
// can use the workers. When a worker fails, is busy restarting or answers with an error, the
// caller builds the page on the main thread as before.
import os from "node:os";
import http from "node:http";
import crypto from "node:crypto";
import { Worker } from "node:worker_threads";
import { logError } from "./log.js";

const CORES = os.availableParallelism?.() || os.cpus().length || 1;
// One core stays with the main thread. NETLENS_VIEW_WORKERS=0 turns the pool off.
const SIZE = process.env.NETLENS_VIEW_WORKERS != null ? Math.max(0, Number(process.env.NETLENS_VIEW_WORKERS) || 0) : Math.min(2, Math.max(0, CORES - 1));
const TIMEOUT_MS = 120_000;
const secret = crypto.randomBytes(24).toString("hex");
const workers = [];
let script = null;
let restarts = [];
let lastFailureLog = 0;

function spawn(i) {
  const w = new Worker(script, { workerData: { role: "views", secret } });
  const entry = { w, port: 0, inflight: 0, alive: true };
  workers[i] = entry;
  w.on("message", (m) => {
    if (m?.ready) entry.port = m.port;
  });
  const gone = (why) => {
    if (!entry.alive) return;
    entry.alive = false;
    entry.port = 0;
    logError("view worker stopped", why instanceof Error ? why : new Error(String(why)));
    // Restart, unless it keeps dying (5 times in 10 minutes): then the main thread does it all.
    const now = Date.now();
    restarts = restarts.filter((t) => now - t < 10 * 60e3);
    if (restarts.length >= 5) return;
    restarts.push(now);
    setTimeout(() => spawn(i), 5000).unref();
  };
  w.on("error", gone);
  w.on("exit", (code) => gone(`exit ${code}`));
  w.unref();
}

export function start(scriptUrl) {
  if (script || SIZE === 0) return;
  script = scriptUrl;
  for (let i = 0; i < SIZE; i++) spawn(i);
}

const ready = () => workers.filter((e) => e?.alive && e.port);
export const available = () => ready().length > 0;
export const size = () => SIZE;

// GET `url` (path and query) from the least busy worker → { status, type, body } or a rejection.
export function request(url, version) {
  const list = ready();
  if (!list.length) return Promise.reject(new Error("no view worker ready"));
  const e = list.reduce((m, x) => (x.inflight < m.inflight ? x : m));
  e.inflight += 1;
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port: e.port, path: url, headers: { "x-netlens-view": secret, "x-netlens-data": String(version) }, timeout: TIMEOUT_MS },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"], timing: res.headers["server-timing"], body: Buffer.concat(chunks) }));
        res.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new Error("view worker timed out")));
    req.on("error", reject);
  }).finally(() => (e.inflight -= 1));
}

// A worker request that failed is answered on the main thread; say so, at most once a minute.
export function noteFailure(url, err) {
  const now = Date.now();
  if (now - lastFailureLog < 60e3) return;
  lastFailureLog = now;
  logError("view worker request (answered on the main thread)", err, { url: url.split("?")[0] });
}

// The worker's check of a request (view mode only).
export function trusted(req, workerSecret) {
  const got = Buffer.from(String(req.get("x-netlens-view") || ""));
  const want = Buffer.from(String(workerSecret || ""));
  return want.length > 0 && got.length === want.length && crypto.timingSafeEqual(got, want);
}
