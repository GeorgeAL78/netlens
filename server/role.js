// Which part of NetLens this thread is (UU-C-210). The main thread does everything; a view
// worker (started by viewpool.js) only builds read-only pages, so modules check this to open
// their databases read-only, skip schema work and never delete or rewrite anything.
import { isMainThread, workerData } from "node:worker_threads";

export const VIEW_WORKER = !isMainThread && workerData?.role === "views";

// A view worker's connection: read-only, and the start-up schema work (CREATE, ALTER,
// UPDATE, journal pragmas) skipped, since the main thread has done it before any worker
// starts. Any other write throws ("attempt to write a readonly database"), the request fails
// in the worker and the main thread answers it instead.
const SCHEMA_WORK = /^\s*(PRAGMA\s+(journal_mode|synchronous)|CREATE|ALTER|UPDATE|DELETE|INSERT|DROP|BEGIN|COMMIT|ROLLBACK)\b/i;
export function readOnlyIfView(database) {
  if (!VIEW_WORKER) return database;
  const exec = database.exec.bind(database);
  database.exec = (sql) => (SCHEMA_WORK.test(sql) ? undefined : exec(sql));
  return database;
}
