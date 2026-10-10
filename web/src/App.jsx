import { useEffect, useRef, useState } from "react";
import { ago, api, deviceGroups, href, go, isPlumbing, useRoute } from "./lib.js";
import { Finder } from "./ui.jsx";
import Home from "./pages/Home.jsx";
import Day from "./pages/Day.jsx";
import Network from "./pages/Network.jsx";
import Security from "./pages/Security.jsx";
import Device from "./pages/Device.jsx";
import Usage from "./pages/Usage.jsx";
import Settings from "./pages/Settings.jsx";
import Alerts from "./pages/Alerts.jsx";
import Devices from "./pages/Devices.jsx";

// The shell of the redesigned interface (UU-C-087): one top bar — home, the three views,
// search and settings — and the page the URL names.
const TABS = [
  ["home", "Home"],
  ["day", "Day"],
  ["usage", "Usage"], // apps, categories and the app picker (UU-C-106)
  ["network", "Network"],
  ["security", "Security"],
  ["devices", "Devices"], // new devices, vendor, names saved in UniFi (UU-C-118)
  ["alerts", "Alerts"], // daily limits per app / device (UU-C-114)
];

// Top-bar search (UU-C-112): devices, plus apps and categories of the last 7 days — an app or
// category opens Usage filtered to it. Loaded on first focus.
function Search() {
  const [devices, setDevices] = useState(null);
  const [week, setWeek] = useState(null);
  const box = useRef(null);
  const load = () => {
    if (devices) return;
    // UniFi's own client list (UU-C-118), so forgotten devices are not offered.
    api("/api/devices").then((d) => setDevices(d.devices || [])).catch(() => setDevices([]));
    api("/api/report?period=7d").then(setWeek).catch(() => setWeek({}));
  };
  const app = (a) => ({ key: `a${a.value}`, label: a.app, sub: "app", pick: () => go("usage", null, { r: "7d", app: a.value }) });
  const choices = week?.appChoices || [];
  const groups = [
    ...deviceGroups(devices, (c) => go("device", c.mac)),
    { label: "Apps", items: choices.filter((a) => !isPlumbing(a)).map(app) },
    {
      label: "Categories",
      items: (week?.categories || []).filter((c) => c.catId != null).map((c) => ({ key: `c${c.catId}`, label: c.category, sub: "category", pick: () => go("usage", null, { r: "7d", cat: c.catId }) })),
    },
    { label: "Protocols and background", items: choices.filter(isPlumbing).map(app) },
  ];
  return (
    <div ref={box} onFocus={load}>
      <Finder groups={groups} placeholder="Find a device, app or category" />
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

// How many alert rules fired today, for the tab's count (UU-C-114). Light: no rule is
// re-evaluated, it only counts what the 5-minute check recorded.
function useFiredToday(page) {
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () => api("/api/alerts?light=1").then((d) => alive && setN(d.fired || 0)).catch(() => {});
    load();
    const t = setInterval(load, 5 * 60 * 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [page]);
  return n;
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
    alerts: Alerts,
    devices: Devices,
  };
  const Page = pages[route.page] || Home;
  const fired = useFiredToday(route.page);
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
              {id === "alerts" && fired > 0 && <span className="count" title="Alerts that fired today">{fired}</span>}
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
