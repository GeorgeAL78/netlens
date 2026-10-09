import fs from "node:fs";
import path from "node:path";
import { logsDir } from "./paths.js";

const MAX_BYTES = 30 * 1024 * 1024;
const KEEP_BYTES = 20 * 1024 * 1024;

function logFile() {
  const dir = logsDir();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "error.log");
}

function redact(text) {
  return String(text || "")
    .replace(/X-API-KEY["\s:=]+[^\s"]+/gi, "X-API-KEY=***")
    .replace(/api[_-]?key["\s:=]+[^\s"]+/gi, "apiKey=***");
}

function truncateIfNeeded(file) {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return;
  }
  if (size <= MAX_BYTES) return;
  const fd = fs.openSync(file, "r");
  try {
    const start = size - KEEP_BYTES;
    const buf = Buffer.alloc(KEEP_BYTES);
    fs.readSync(fd, buf, 0, KEEP_BYTES, start);
    const nl = buf.indexOf(10);
    const body = nl >= 0 ? buf.subarray(nl + 1) : buf;
    fs.writeFileSync(file, Buffer.concat([Buffer.from(`--- truncated ${new Date().toISOString()} kept last ~20MB ---\n`), body]));
  } finally {
    fs.closeSync(fd);
  }
}

export function logLine(level, source, message, extra) {
  const file = logFile();
  const payload = extra != null ? ` ${redact(typeof extra === "string" ? extra : JSON.stringify(extra))}` : "";
  const line = `${new Date().toISOString()} [${level}] [${source}] ${redact(message)}${payload}\n`;
  fs.appendFileSync(file, line);
  truncateIfNeeded(file);
}

export function logError(source, err, extra) {
  const message = err?.stack || err?.message || String(err);
  logLine("error", source, message, extra);
  console.error(source, err?.message || err);
}
