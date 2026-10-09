import crypto from "node:crypto";
import * as db from "./db.js";

// Login managed in the web UI (UU-C-059): the password is set on first run or in
// Settings, stored only as a scrypt hash, and a signed session cookie keeps you logged in.
// Replaces the UI_PASSWORD environment variable and the browser's Basic-auth prompt.
const COOKIE = "netlens_session";
const SESSION_DAYS = 30;
const SCRYPT = { N: 16384, r: 8, p: 1 };

export const hasPassword = () => Boolean(db.getSetting("ui_password_hash", ""));

function secret() {
  let s = db.getSetting("session_secret", "");
  if (!s) {
    s = crypto.randomBytes(32).toString("base64");
    db.setSetting("session_secret", s);
  }
  return s;
}

export function setPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64, SCRYPT);
  db.setSetting("ui_password_hash", `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`);
  // A new secret signs out every other session.
  db.setSetting("session_secret", crypto.randomBytes(32).toString("base64"));
}

export function clearPassword() {
  db.setSetting("ui_password_hash", "");
}

export function checkPassword(password) {
  const stored = db.getSetting("ui_password_hash", "");
  const [, salt, hash] = stored.split("$");
  if (!salt || !hash) return false;
  const got = crypto.scryptSync(String(password ?? ""), Buffer.from(salt, "base64"), 64, SCRYPT);
  const want = Buffer.from(hash, "base64");
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

function sign(body) {
  return crypto.createHmac("sha256", secret()).update(body).digest("base64url");
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function startSession(res) {
  const expires = Date.now() + SESSION_DAYS * 86400e3;
  const body = String(expires);
  res.cookie(COOKIE, `${body}.${sign(body)}`, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DAYS * 86400e3,
  });
}

export function endSession(res) {
  res.clearCookie(COOKIE, { path: "/" });
}

export function hasSession(req) {
  const raw = cookies(req)[COOKIE];
  if (!raw) return false;
  const [body, sig] = raw.split(".");
  if (!body || !sig) return false;
  const want = Buffer.from(sign(body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return false;
  return Number(body) > Date.now();
}

// 5 wrong passwords from one address lock it out for 5 minutes (same as unifi-toolkit).
const failures = new Map();
export function lockedOut(ip) {
  const f = failures.get(ip);
  return Boolean(f && f.until > Date.now());
}
export function recordFailure(ip) {
  const f = failures.get(ip) || { count: 0, until: 0 };
  f.count += 1;
  if (f.count >= 5) {
    f.until = Date.now() + 5 * 60e3;
    f.count = 0;
  }
  failures.set(ip, f);
}
export function clearFailures(ip) {
  failures.delete(ip);
}

export const LOGIN_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NetLens · Log in</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0f17;color:#e2e8f0;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  form{width:min(340px,90vw);padding:28px;border-radius:16px;background:#131823;border:1px solid #242d3e}
  h1{margin:0 0 4px;font-size:20px} p{margin:0 0 18px;color:#8a96ab;font-size:13px}
  label{display:block;font-size:12px;color:#8a96ab;margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em}
  input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:10px;border:1px solid #2b3548;background:#0f141e;color:#e2e8f0;font-size:15px}
  button{margin-top:16px;width:100%;padding:10px;border:0;border-radius:10px;background:#38bdf8;color:#04121c;font-weight:600;font-size:15px;cursor:pointer}
  .err{color:#fca5a5;font-size:13px;margin-top:10px;min-height:18px}
</style></head><body>
<form id="f"><h1>NetLens</h1><p>Log in to continue.</p>
<label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" autofocus required>
<button type="submit">Log in</button><div class="err" id="e"></div></form>
<script>
document.getElementById("f").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const e = document.getElementById("e"); e.textContent = "";
  const r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: document.getElementById("pw").value }) });
  if (r.ok) { const n = new URLSearchParams(location.search).get("next"); location.href = n && n.startsWith("/") && !n.startsWith("//") ? n : "/"; return; }
  const j = await r.json().catch(() => ({})); e.textContent = j.error || "Login failed";
});
</script></body></html>`;
