// A worker thread for destpool.js (UU-C-208): its own read-only connection to flows.db, one
// task at a time. When a result is posted it raises its flag, so the main thread, which waits
// on the flag, can pick the result up without returning to its event loop.
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { destinationsWith } from "./destcore.js";

const db = new DatabaseSync(workerData.file, { readOnly: true });
const flags = new Int32Array(workerData.flags);
const slot = workerData.slot;

workerData.port.on("message", ({ id, days, items, limit }) => {
  let msg;
  try {
    msg = { id, result: destinationsWith(db, days, items, limit) };
  } catch (err) {
    msg = { id, error: err.message };
  }
  workerData.port.postMessage(msg);
  Atomics.store(flags, slot, 1);
  Atomics.notify(flags, slot);
});
parentPort?.postMessage("ready");
