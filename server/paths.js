import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const appRoot = process.env.UNIFI_APP_ROOT || path.resolve(__dirname, "..");
export const databaseDir = process.env.UNIFI_DATABASE_DIR || path.join(appRoot, "database");
export const dataDir = databaseDir;
export const dbFile = path.join(databaseDir, "unifi-usage.db");
export function logsDir() {
  return process.env.UNIFI_LOG_DIR || path.join(path.dirname(databaseDir), "logs");
}

const legacyDir = path.join(
  process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
  "UniFiUsage"
);
const legacyEnv = path.join(legacyDir, ".env");
const bundledEnv = path.join(appRoot, ".env");

fs.mkdirSync(databaseDir, { recursive: true });

// The old PC app's database is adopted only for the default PC folder — never when a folder
// is set explicitly (Docker, demo data, test copies), or a "fresh" demo would start as a copy
// of the owner's real devices (UU-C-129).
if (!process.env.UNIFI_DATABASE_DIR && !fs.existsSync(dbFile)) {
  const oldDb = path.join(legacyDir, "data", "usage.db");
  if (fs.existsSync(oldDb)) {
    fs.copyFileSync(oldDb, dbFile);
    for (const suffix of ["-wal", "-shm"]) {
      const src = oldDb + suffix;
      if (fs.existsSync(src)) fs.copyFileSync(src, dbFile + suffix);
    }
  }
}

// quiet: dotenv otherwise prints "injected env (N) from <path>" to stderr on every start,
// which Docker and Unraid show as an error and which names the user's folders (UU-F-054).
dotenv.config({ path: bundledEnv, quiet: true });
dotenv.config({ path: legacyEnv, quiet: true });
dotenv.config({ path: path.join(databaseDir, ".env"), quiet: true });
