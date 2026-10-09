// Rebuilds server/data/ip2asn.tsv.gz from IPinfo Lite.
//
//   IPINFO_TOKEN=... node scripts/build-ip2asn.mjs
//
// The token is read from the environment and never written to disk — it must not end up
// in the repository. Get one free at ipinfo.io; the Lite dataset is CC BY-SA 4.0 and the
// attribution is recorded in server/data/README.md.
//
// The published file is /24-granular (3.6M rows, 272 MB uncompressed), and most rows are
// adjacent entries for the same network. Collapsing those runs into ranges gets it down
// to something sane to vendor, with no loss: the lookup only ever asks which range an
// address falls in.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "server", "data", "ip2asn.tsv.gz");

function ipToInt(ip) {
  const p = ip.split(".");
  return ((+p[0] << 24) >>> 0) + (+p[1] << 16) + (+p[2] << 8) + +p[3];
}

async function source() {
  const local = process.argv[2];
  if (local) return fs.readFileSync(local);
  const token = process.env.IPINFO_TOKEN;
  if (!token) {
    console.error("Set IPINFO_TOKEN, or pass a path to an already-downloaded ipinfo_lite.csv.gz");
    process.exit(2);
  }
  const res = await fetch(`https://ipinfo.io/data/ipinfo_lite.csv.gz?token=${token}`, { redirect: "follow" });
  if (!res.ok) {
    console.error(`download failed: HTTP ${res.status}`);
    process.exit(1);
  }
  return Buffer.from(await res.arrayBuffer());
}

const csv = zlib.gunzipSync(await source()).toString("utf8");
const lines = csv.split("\n");
const header = lines[0].split(",");
const iNet = header.indexOf("network");
const iName = header.indexOf("as_name");
const iDomain = header.indexOf("as_domain");

// "Cloudflare, Inc." is quoted and contains a comma, so split on commas outside quotes.
function fields(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === "," && !q) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const ranges = [];
let kept = 0;
for (let i = 1; i < lines.length; i += 1) {
  const line = lines[i];
  if (!line) continue;
  const f = fields(line);
  const net = f[iNet];
  const label = (f[iDomain] || f[iName] || "").trim();
  if (!net || !label) continue;
  const [base, bitsRaw] = net.split("/");
  const bits = Number(bitsRaw);
  if (!base.includes(".") || !Number.isFinite(bits)) continue;
  const start = ipToInt(base);
  const end = start + 2 ** (32 - bits) - 1;
  kept += 1;
  const prev = ranges[ranges.length - 1];
  // Collapse a run of adjacent networks that belong to the same operator.
  if (prev && prev.label === label && prev.end + 1 === start) prev.end = end;
  else ranges.push({ start, end, label });
}

const body = ranges.map((r) => `${r.start}\t${r.end}\t${r.label}`).join("\n");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, zlib.gzipSync(Buffer.from(body, "utf8"), { level: 9 }));

const size = fs.statSync(out).size;
console.log(`rows read     : ${kept}`);
console.log(`ranges written: ${ranges.length}`);
console.log(`${path.relative(root, out)}: ${(size / 1048576).toFixed(1)} MB gzipped`);
