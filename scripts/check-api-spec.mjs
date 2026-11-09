// The API table (server/apispec.js, UU-C-227) must match the routes in server/index.js: every
// tool's method and path is registered, tool names are unique, and no write tool reaches a route
// that is never a "safe change" (blocking, settings, password, key, import/export, shutdown).
import { readFileSync } from "node:fs";
import { TOOLS, isKeyWrite } from "../server/apispec.js";

const src = readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
const routes = new Set([...src.matchAll(/^app\.(get|post|put|delete)\("([^"]+)"/gm)].map((m) => `${m[1].toUpperCase()} ${m[2]}`));
const problems = [];
const names = new Set();
for (const t of TOOLS) {
  if (names.has(t.name)) problems.push(`duplicate tool name ${t.name}`);
  names.add(t.name);
  const route = `${t.method} ${t.path.replace(/\{([^}]+)\}/g, ":$1")}`;
  if (!routes.has(route)) problems.push(`${t.name}: no route ${route} in server/index.js`);
  if (t.method !== "GET" && !t.write) problems.push(`${t.name}: ${t.method} must be marked write`);
  for (const [k, p] of Object.entries(t.params)) {
    if (!["query", "path", "body"].includes(p.in)) problems.push(`${t.name}.${k}: in must be query, path or body`);
    if (p.in === "path" && !t.path.includes(`{${k}}`)) problems.push(`${t.name}.${k}: not in the path`);
  }
}
const NEVER = [
  ["POST", `/api/clients/${["aa", "bb", "cc", "dd", "ee", "ff"].join(":")}/block`],
  ["PUT", "/api/settings"],
  ["POST", "/api/password"],
  ["POST", "/api/password/remove"],
  ["POST", "/api/login-mode"],
  ["POST", "/api/access-key"],
  ["DELETE", "/api/access-key"],
  ["POST", "/api/history/import"],
  ["POST", "/api/shutdown"],
  ["POST", "/api/cache/refetch"],
];
for (const [m, p] of NEVER) if (isKeyWrite(m, p)) problems.push(`a full key could ${m} ${p}`);

if (problems.length) {
  for (const p of problems) console.log(`  FAIL ${p}`);
  console.log(`\n  ${problems.length} PROBLEM(S) in the API table`);
  process.exit(1);
}
console.log(`PASS API table: ${TOOLS.length} tools (${TOOLS.filter((t) => t.write).length} changes), each a route in server/index.js; no full-key write reaches blocking, settings, password, key, import or shutdown`);
