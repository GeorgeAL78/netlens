// Enforces REVIEW rule 8: /api/report must never reach UniFi.
//
// A grep for "unifi." inside the handler is not enough — that is how UU-F-021 slipped
// through, because ensureDpi() reached the console one level down. This follows the
// call graph and strips comments first, since a mention in a comment is not a call.
//
// Run: node scripts/check-report-isolation.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const raw = fs.readFileSync(path.join(root, "server/index.js"), "utf8");
const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function sliceBalanced(from) {
  let depth = 0;
  let started = false;
  for (let i = from; i < src.length; i += 1) {
    if (src[i] === "{") {
      depth += 1;
      started = true;
    } else if (src[i] === "}") {
      depth -= 1;
      if (started && depth === 0) return src.slice(from, i + 1);
    }
  }
  return src.slice(from);
}

const start = src.indexOf('app.get("/api/report"');
if (start < 0) {
  console.error("check-report-isolation: could not find the /api/report handler");
  process.exit(2);
}
// Since UU-C-114 the handler is a thin wrapper over buildReport(), which alert checks reuse;
// both must stay synchronous and UniFi-free.
const builder = src.indexOf("function buildReport(");
const body = sliceBalanced(start) + (builder >= 0 ? sliceBalanced(builder) : "");

const problems = [];
const awaits = (body.match(/\bawait\b/g) || []).length;
if (awaits) problems.push(`${awaits} await(s) in the handler / buildReport — the report must be fully synchronous`);
if (/\bunifi\./.test(body)) problems.push("handler references unifi.* directly");

for (const name of new Set([...body.matchAll(/\b([a-zA-Z_$][\w$]*)\s*\(/g)].map((m) => m[1]))) {
  const decl = src.match(new RegExp(String.raw`(?:async\s+)?function\s+${name}\s*\(`));
  if (!decl) continue;
  if (/\bunifi\./.test(sliceBalanced(src.indexOf(decl[0])))) {
    problems.push(`helper ${name}() reaches unifi.*`);
  }
}

if (problems.length) {
  console.error("FAIL /api/report can reach UniFi (REVIEW rule 8):");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log("PASS /api/report cannot reach UniFi (no await, no unifi.*, no helper reaches it)");
