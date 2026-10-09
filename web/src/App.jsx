import { useEffect, useMemo, useRef, useState } from "react";
import { ago, api, href, go, useRoute } from "./lib.js";
import Home from "./pages/Home.jsx";
import Day from "./pages/Day.jsx";
import Network from "./pages/Network.jsx";
import Security from "./pages/Security.jsx";
import Device from "./pages/Device.jsx";
import Usage from "./pages/Usage.jsx";
import Settings from "./pages/Settings.jsx";

// The shell of the redesigned interface (UU-C-087): one top bar — home, the three views,
// search and settings — and the page the URL names.
const TABS = [
  ["home", "Home"],
  ["day", "Day"],
  ["network", "Network"],
  ["security", "Security"],
];

function Search() {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [list, setList] = useState(null);
  const [sel, setSel] = useState(0);
  const box = useRef(null);
  useEffect(() => {
    if (!open || list) return;
    api("/api/clients?scope=all")
      .then((d) => setList(d.clients || []))
      .catch(() => setList([]));
  }, [open, list]);
  useEffect(() => {
    const close = (e) => box.current && !box.current.contains(e.target) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s || !list) return [];
    return list
      .filter((c) => [c.name, c.hostname, c.mac, c.ip].some((v) => String(v || "").toLowerCase().includes(s)))
      .slice(0, 12);
  }, [q, list]);
  const pick = (c) => {
    setOpen(false);
    setQ("");
    go("device", c.mac);
  };
  return (
    <div className="search" ref={box}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <circle cx="11" cy="11" r="6" />
        <path d="M20 20l-4.5-4.5" />
      </svg>
      <input
        aria-label="Find a device"
        placeholder="Find a device"
        value={q}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQ(e.target.value);
          setSel(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setSel((i) => Math.min(i + 1, results.length - 1));
          else if (e.key === "ArrowUp") setSel((i) => Math.max(i - 1, 0));
          else if (e.key === "Enter" && results[sel]) pick(results[sel]);
          else if (e.key === "Escape") setOpen(false);
        }}
      />
      {open && q.trim() && (
        <div className="search-results">
          {!list && <div className="dim small" style={{ padding: 10 }}>Loading devices…</div>}
          {list && !results.length && <div className="dim small" style={{ padding: 10 }}>No device matches “{q}”.</div>}
          {results.map((c, i) => (
            <a
              key={c.mac}
              href={href("device", c.mac)}
              className={i === sel ? "on" : ""}
              onClick={(e) => {
                e.preventDefault();
                pick(c);
              }}
            >
              <span className="ellipsis">{c.name || c.hostname || c.mac}</span>
              <span className="dim small">{c.online ? "online" : "offline"}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

// Fetch the newest data from UniFi now, then redraw the page (UU-C-089). NetLens also does this
// by itself every 5 minutes; the button is for "show me right now".
function Refresh({ onDone }) {
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    api("/api/cache").then((c) => setLast(c.fetchedAt)).catch(() => {});
  }, []);
  async function run() {
    setBusy(true);
    setErr("");
    try {
      const c = await api("/api/cache/delta", { method: "POST", body: JSON.stringify({}) });
      setLast(c.fetchedAt || Date.now());
      onDone();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      className={`iconbtn ${busy ? "spin" : ""}`}
      onClick={run}
      disabled={busy}
      aria-label="Refresh data now"
      title={err ? `Refresh failed: ${err}` : busy ? "Fetching from UniFi…" : `Refresh now · updated ${ago(last)}`}
      style={err ? { borderColor: "var(--bad)", color: "var(--bad)" } : undefined}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
        <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" />
      </svg>
    </button>
  );
}

function useVersion() {
  const [v, setV] = useState("");
  useEffect(() => {
    fetch("/healthz")
      .then((r) => r.json())
      .then((j) => setV(j.version || ""))
      .catch(() => {});
  }, []);
  return v;
}

export default function App() {
  const route = useRoute();
  const version = useVersion();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route.page, route.arg]);
  const pages = {
    home: Home,
    day: Day,
    network: Network,
    security: Security,
    device: Device,
    usage: Usage,
    settings: Settings,
  };
  const Page = pages[route.page] || Home;
  // Bumped by Refresh: remounts the page so it loads everything again.
  const [refreshKey, setRefreshKey] = useState(0);
  return (
    <>
      <header className="topbar">
        <a className="brand" href={href("home")} aria-label="NetLens home">
          <span className="brand-mark" aria-hidden="true" />
          <strong>NetLens</strong>
          {version && <small>{/^\d/.test(version) ? `v${version}` : version}</small>}
        </a>
        <nav className="tabs" aria-label="Views">
          {TABS.map(([id, label]) => (
            <a key={id} href={href(id)} className={route.page === id ? "on" : ""}>
              {label}
            </a>
          ))}
        </nav>
        <span className="spacer" />
        <Search />
        <Refresh onDone={() => setRefreshKey((k) => k + 1)} />
        <a className={`iconbtn ${route.page === "settings" ? "on" : ""}`} href={href("settings")} aria-label="Settings" title="Settings">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="M4 7h9M17 7h3M15 5v4M4 17h3M11 17h9M9 15v4" />
          </svg>
        </a>
      </header>
      <Page key={refreshKey} route={route} version={version} />
    </>
  );
}
