// Rebuilds server/data/oui.tsv.gz from Wireshark's manuf file (UU-C-194).
//
//   node scripts/build-oui.mjs <manuf.gz>
//
// Download it first: https://www.wireshark.org/download/automated/data/manuf.gz (at most once a
// week, its header asks). It is built from the IEEE's public listings, which refuse scripted
// downloads. Each row becomes "<prefix in hex><TAB><maker>"; a prefix of 6, 7 or 9 digits is a
// 24, 28 or 36 bit block.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "server", "data", "oui.tsv.gz");

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/build-oui.mjs <manuf.gz>");
  process.exit(1);
}
const raw = fs.readFileSync(file);
const text = (raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw) : raw).toString("utf8");

const rows = [];
for (const line of text.split(/\r?\n/)) {
  if (!line || line.startsWith("#")) continue;
  const [block, short, full] = line.split("\t").map((s) => s.trim());
  const [addr, bits = "24"] = block.split("/");
  const digits = Number(bits) / 4;
  const prefix = addr.replace(/[:.-]/g, "").toLowerCase().slice(0, digits);
  // 00:00:00 is an empty address far more often than a Xerox.
  if (!/^[0-9a-f]+$/.test(prefix) || ![6, 7, 9].includes(prefix.length) || /^0+$/.test(prefix)) continue;
  const maker = full || short;
  if (maker) rows.push(`${prefix}\t${maker}`);
}
if (rows.length < 10000) throw new Error(`only ${rows.length} rows: is this a manuf file?`);
fs.writeFileSync(out, zlib.gzipSync(rows.join("\n"), { level: 9 }));
console.log(`${rows.length} prefixes, ${(fs.statSync(out).size / 1e6).toFixed(2)} MB -> ${path.relative(root, out)}`);
