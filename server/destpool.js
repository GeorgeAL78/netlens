// Session destinations on every core (UU-C-208). Node runs a report on one thread; reading the
// connection records behind a 30-day report's sessions is most of its time, and it splits by
// device. Up to 4 worker threads each read their share of devices from their own read-only
// connection (flows.db is WAL, so readers never block the writer).
//
// The report code stays synchronous: the main thread posts the shares, waits on shared flags
// (Atomics.wait — it would be busy with this report anyway), then takes the results with
// receiveMessageOnPort, which needs no trip through the event loop. A worker that fails or
// takes over a minute is dropped and its share done here, so a report never fails over it.
import os from "node:os";
import { Worker, MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import { destinationsWith } from "./destcore.js";

const SIZE = Math.max(1, Math.min(4, os.availableParallelism?.() || os.cpus().length || 1));
// Below this a report is small enough that handing it out costs more than it saves.
const MIN_ITEMS = 40;
const TIMEOUT_MS = 60_000;

let flags = null;
const workers = [];
let nextId = 1;

function start(file, slot) {
  const { port1, port2 } = new MessageChannel();
  const w = new Worker(new URL("./destworker.js", import.meta.url), {
    workerData: { file, flags: flags.buffer, slot, port: port2 },
    transferList: [port2],
  });
  const entry = { w, port: port1, alive: true };
  w.on("error", () => (entry.alive = false));
  w.on("exit", () => (entry.alive = false));
  w.unref();
  port1.unref?.();
  return entry;
}

function pool(file) {
  if (!flags) flags = new Int32Array(new SharedArrayBuffer(4 * SIZE));
  for (let i = 0; i < SIZE; i++) {
    if (!workers[i] || !workers[i].alive) workers[i] = start(file, i);
  }
  return workers;
}

function drop(i) {
  const e = workers[i];
  if (!e) return;
  e.alive = false;
  e.w.terminate().catch(() => {});
  workers[i] = null;
}

// Same answer as destinationsWith(db, days, items, limit), computed on the pool when it pays.
export function destinationsParallel(db, file, days, items, limit) {
  const byMac = new Map();
  items.forEach((it, i) => {
    if (!byMac.has(it.mac)) byMac.set(it.mac, []);
    byMac.get(it.mac).push(i);
  });
  if (SIZE < 2 || items.length < MIN_ITEMS || byMac.size < 2) return destinationsWith(db, days, items, limit);

  // Busiest devices first, each to the least loaded share.
  const shares = Array.from({ length: SIZE }, () => ({ idx: [], load: 0 }));
  for (const idx of [...byMac.values()].sort((a, b) => b.length - a.length)) {
    const s = shares.reduce((m, x) => (x.load < m.load ? x : m));
    s.idx.push(...idx);
    s.load += idx.length;
  }
  const ws = pool(file);
  const sent = [];
  shares.forEach((s, i) => {
    if (!s.idx.length) return;
    const id = nextId++;
    Atomics.store(flags, i, 0);
    ws[i].port.postMessage({ id, days, items: s.idx.map((k) => items[k]), limit });
    sent.push({ i, id, idx: s.idx });
  });

  const out = new Array(items.length);
  const deadline = Date.now() + TIMEOUT_MS;
  for (const { i, id, idx } of sent) {
    let result = null;
    while (!result) {
      const left = deadline - Date.now();
      if (left <= 0 || Atomics.wait(flags, i, 0, left) === "timed-out") break;
      const m = receiveMessageOnPort(ws[i].port);
      if (!m) {
        // Flag up with nothing queued: a stale flag; lower it and wait again.
        Atomics.store(flags, i, 0);
        continue;
      }
      if (m.message.id !== id) continue; // a late answer to an abandoned task
      if (m.message.error) break;
      result = m.message.result;
    }
    if (!result) {
      drop(i);
      result = destinationsWith(db, days, idx.map((k) => items[k]), limit);
    }
    idx.forEach((k, j) => (out[k] = result[j]));
  }
  return out;
}
