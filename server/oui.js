import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A device's maker from its address (UU-C-194), for the addresses UniFi knows no maker for: a
// snapshot of the public registry, see data/README.md. Registries hand out smaller blocks inside
// bigger ones, so the longest prefix wins.
const here = path.dirname(fileURLToPath(import.meta.url));
let table = null;

function load() {
  try {
    const text = zlib.gunzipSync(fs.readFileSync(path.join(here, "data", "oui.tsv.gz"))).toString("utf8");
    table = new Map(text.split("\n").map((l) => l.split("\t")));
  } catch {
    table = new Map();
  }
  return table;
}

export function makerOf(mac) {
  const hex = String(mac || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  if (hex.length !== 12 || /^0+$/.test(hex)) return null;
  // A private (randomised) address says nothing about who made the device.
  if (parseInt(hex.slice(0, 2), 16) & 2) return null;
  const t = table || load();
  return t.get(hex.slice(0, 9)) || t.get(hex.slice(0, 7)) || t.get(hex.slice(0, 6)) || null;
}
