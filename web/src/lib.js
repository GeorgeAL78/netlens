import { useCallback, useEffect, useState } from "react";

// Shared plumbing for the redesigned interface (UU-C-087): API calls, formatting and a small
// hash router — the URL says which page, day, device and filters are open, so Back, reload
// and bookmarks all work.

export async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) },
  });
  if (res.status === 401) {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.hash)}`;
    throw new Error("Login required");
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}

// Load JSON for `path`; reloads when `path` changes, and every `refreshMs` when given.
export function useApi(path, refreshMs = 0) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return undefined;
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    api(path)
      .then((data) => live && setState({ data, error: null, loading: false }))
      .catch((err) => live && setState((s) => ({ ...s, error: err.message, loading: false })));
    return () => {
      live = false;
    };
  }, [path, tick]);
  useEffect(() => {
    if (!refreshMs) return undefined;
    const id = setInterval(() => setTick((t) => t + 1), refreshMs);
    return () => clearInterval(id);
  }, [refreshMs]);
  return { ...state, reload: useCallback(() => setTick((t) => t + 1), []) };
}

// ---- router ---------------------------------------------------------------------------
function parse() {
  const raw = window.location.hash.replace(/^#/, "") || "/";
  const [p, q = ""] = raw.split("?");
  const parts = p.split("/").filter(Boolean).map(decodeURIComponent);
  return { page: parts[0] || "home", arg: parts[1] || null, query: Object.fromEntries(new URLSearchParams(q)) };
}

export function useRoute() {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export function href(page, arg, query) {
  const q = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== "")).toString() : "";
  return `#/${page === "home" ? "" : page}${arg ? `/${encodeURIComponent(arg)}` : ""}${q ? `?${q}` : ""}`;
}

export function go(page, arg, query) {
  window.location.hash = href(page, arg, query);
}

// ---- formatting -------------------------------------------------------------------------
export function bytes(n) {
  if (n == null || Number.isNaN(n)) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = Number(n);
  while (v >= 1000 && i < u.length - 1) {
    v /= 1000;
    i += 1;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

export function rate(kbps) {
  if (kbps == null) return "—";
  return kbps >= 1e6 ? `${(kbps / 1e6).toFixed(2)} Gbps` : kbps >= 1000 ? `${Math.round(kbps / 1000)} Mbps` : `${kbps} kbps`;
}

export function speed(mbps) {
  if (mbps == null) return "—";
  return mbps >= 1000 ? `${+(mbps / 1000).toFixed(1)} Gbps` : `${mbps} Mbps`;
}

export function duration(seconds) {
  if (seconds == null) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

export const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
export const dayLabel = (key) =>
  new Date(`${key}T12:00:00`).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
export const shortDate = (ms) => new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function addDays(key, n) {
  const d = new Date(`${key}T12:00:00`);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

export function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function ago(ms) {
  if (!ms) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

// Heat colour for a share 0..1 of the busiest cell.
export function heat(share) {
  if (!(share > 0)) return "var(--cell-0)";
  if (share < 0.08) return "var(--cell-1)";
  if (share < 0.25) return "var(--cell-2)";
  if (share < 0.5) return "var(--cell-3)";
  if (share < 0.8) return "var(--cell-4)";
  return "var(--cell-5)";
}
