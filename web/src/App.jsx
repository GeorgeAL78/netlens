import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { ago, api, applyTheme, deviceGroups, go, href, isPlumbing, setPinned, setTheme, themeChoice, usePending, usePins, useRoute } from "./lib.js";
import { Loading } from "./ui.jsx";
import { Icon } from "./icons.jsx";

// Pages load when first opened (UU-C-289): the first screen no longer waits for every page's code.
const PAGES = {
  home: lazy(() => import("./pages/Home.jsx")),
  day: lazy(() => import("./pages/Day.jsx")),
  network: lazy(() => import("./pages/Network.jsx")),
  security: lazy(() => import("./pages/Security.jsx")),
  device: lazy(() => import("./pages/Device.jsx")),
  usage: lazy(() => import("./pages/Usage.jsx")),
  settings: lazy(() => import("./pages/Settings.jsx")),
  alerts: lazy(() => import("./pages/Alerts.jsx")),
  devices: lazy(() => import("./pages/Devices.jsx")),
  sites: lazy(() => import("./pages/Sites.jsx")),
  wifi: lazy(() => import("./pages/Wifi.jsx")),
  internet: lazy(() => import("./pages/Internet.jsx")),
  live: lazy(() => import("./pages/Live.jsx")),
  firewall: lazy(() => import("./pages/Firewall.jsx")),
};

// ---- navigation: every page, grouped by the question it answers ----
// Old addresses all still work: the pages keep their ids, only the shell around them changed.
const GROUPS = [
  { id: "home", label: null, items: [["home", "Overview", "home"]] },
  { id: "activity", label: "Activity", items: [["day", "Timeline", "timeline"], ["usage", "Apps", "apps"], ["sites", "Sites", "sites"]] },
  { id: "devices", label: "Devices", items: [["devices", "All devices", "devices"]], also: ["device"] },
  { id: "network", label: "Network", items: [["network", "Map", "map"], ["wifi", "Wi-Fi", "wifi"], ["internet", "Internet", "internet"], ["live", "Live", "live"]] },
  { id: "protection", label: "Protection", items: [["security", "Blocked", "shield"], ["firewall", "Firewall rules", "rules"], ["alerts", "Limits", "bell"]] },
];
const ALL_PAGES = [...GROUPS.flatMap((g) => g.items.map(([id, label, icon]) => ({ id, label, icon, group: g.label }))), { id: "settings", label: "Settings", icon: "settings", group: null }];
const groupOf = (page) => GROUPS.find((g) => g.items.some(([id]) => id === page) || g.also?.includes(page));
const pageLabel = (page) => ALL_PAGES.find((p) => p.id === page)?.label || (page === "device" ? "Device" : "");

// Activity remembers which of its pages you used last (UU-C-163).
const LAST_ACTIVITY = "netlens.activity";
const lastActivity = () => {
  try {
    const v = localStorage.getItem(LAST_ACTIVITY);
    return ["day", "usage", "sites"].includes(v) ? v : "day";
  } catch {
    return "day";
  }
};

// Fetch the newest data from UniFi now, then redraw the page (UU-C-089). NetLens also does this
// by itself every 5 minutes; the button is for "show me right now".
function useRefresh(onDone) {
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    const load = () => api("/api/cache").then((c) => setLast(c.fetchedAt)).catch(() => {});
    load();
    const t = setInterval(load, 60 * 1000);
    return () => clearInterval(t);
  }, []);
  async function run() {
    if (busy) return;
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
  return { busy, last, err, run };
}
function RefreshButton({ r }) {
  return (
    <button
      className={`iconbtn ${r.busy ? "spin" : ""}`}
      onClick={r.run}
      disabled={r.busy}
      aria-label="Refresh data now"
      title={r.err ? `Refresh failed: ${r.err}` : r.busy ? "Fetching from UniFi…" : `Refresh now · updated ${ago(r.last)}`}
      style={r.err ? { borderColor: "var(--bad)", color: "var(--bad)" } : undefined}
    >
      <Icon name="refresh" size={16} />
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

// How many limits were reached today (UU-C-114). Light: it only counts what the 5-minute check recorded.
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

// Light, dark, or the device's own setting.
function useTheme() {
  const [choice, setChoice] = useState(themeChoice);
  useEffect(() => {
    applyTheme(choice);
    if (choice !== "system" || !window.matchMedia) return undefined;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const on = () => applyTheme("system");
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, [choice]);
  const pick = (c) => {
    setTheme(c);
    setChoice(c);
  };
  const next = () => pick(choice === "system" ? "light" : choice === "light" ? "dark" : "system");
  return { choice, pick, next };
}
const THEME_WORD = { system: "Theme: automatic", light: "Theme: light", dark: "Theme: dark" };
const THEME_ICON = { system: "auto", light: "sun", dark: "moon" };

// ---- command palette: pages, pinned devices, devices, apps, categories and actions ----
function Palette({ onClose, actions }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [devices, setDevices] = useState(null);
  const [week, setWeek] = useState(null);
  const pins = usePins() || [];
  const input = useRef(null);
  const list = useRef(null);
  useEffect(() => {
    input.current?.focus();
    // UniFi's own client list (UU-C-118), so forgotten devices are not offered.
    api("/api/devices").then((d) => setDevices(d.devices || [])).catch(() => setDevices([]));
    api("/api/report?period=7d").then(setWeek).catch(() => setWeek({}));
  }, []);
  const groups = useMemo(() => {
    const close = (f) => () => {
      onClose();
      f();
    };
    const app = (a) => ({ key: `a${a.value}`, label: a.app, sub: "app · last 7 days", icon: "apps", pick: close(() => go("usage", null, { r: "7d", app: a.value })) });
    const choices = week?.appChoices || [];
    const devGroups = deviceGroups(devices, (c) => go("device", c.mac)).map((g) => ({ ...g, items: g.items.map((i) => ({ ...i, icon: "device", pick: close(i.pick) })) }));
    return [
      { label: "Pages", items: ALL_PAGES.map((p) => ({ key: `p${p.id}`, label: p.label, sub: p.group || "", icon: p.icon, searchable: [p.group], pick: close(() => go(p.id === "day" ? lastActivity() : p.id)) })) },
      { label: "Pinned", items: pins.map((p) => ({ key: `pin${p.mac}`, label: p.name, sub: "pinned", icon: "star", searchable: [p.mac], pick: close(() => go("device", p.mac)) })) },
      { label: "Actions", items: actions.map((a) => ({ ...a, icon: a.icon || "arrow", pick: close(a.run) })) },
      ...devGroups,
      { label: "Apps", items: choices.filter((a) => !isPlumbing(a)).map(app) },
      { label: "Categories", items: (week?.categories || []).filter((c) => c.catId != null).map((c) => ({ key: `c${c.catId}`, label: c.category, sub: "category · last 7 days", icon: "apps", pick: close(() => go("usage", null, { r: "7d", cat: c.catId })) })) },
      { label: "Protocols and background", searchOnly: true, items: choices.filter(isPlumbing).map(app) },
    ];
  }, [devices, week, pins, actions, onClose]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return groups
      .filter((g) => s || (!g.searchOnly && g.label !== "Unnamed and offline"))
      .map((g) => ({ ...g, items: g.items.filter((i) => !s || [i.label, i.sub, ...(i.searchable || [])].join(" ").toLowerCase().includes(s)).slice(0, s ? 10 : g.label === "Pages" || g.label === "Actions" || g.label === "Pinned" ? 20 : 6) }))
      .filter((g) => g.items.length);
  }, [q, groups]);
  const flat = shown.flatMap((g) => g.items);
  useEffect(() => {
    list.current?.querySelector("a.on")?.scrollIntoView({ block: "nearest" });
  }, [sel]);
  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Find anything">
        <div className="palette-input">
          <Icon name="search" />
          <input
            ref={input}
            value={q}
            placeholder="Find a page, device, app or action"
            aria-label="Find a page, device, app or action"
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((i) => Math.min(i + 1, flat.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter" && flat[sel]) flat[sel].pick();
              else if (e.key === "Escape") onClose();
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list" ref={list} role="listbox">
          {devices == null && <div className="dim small" style={{ padding: 10 }}>Loading devices and apps…</div>}
          {q.trim() && !flat.length && devices != null && <div className="dim small" style={{ padding: 10 }}>Nothing matches “{q}”.</div>}
          {shown.map((g) => (
            <div key={g.label}>
              <div className="grp">{g.label}</div>
              {g.items.map((i) => {
                const n = flat.indexOf(i);
                return (
                  <a
                    key={i.key}
                    href="#"
                    role="option"
                    aria-selected={n === sel}
                    className={n === sel ? "on" : ""}
                    onMouseMove={() => n !== sel && setSel(n)}
                    onClick={(e) => {
                      e.preventDefault();
                      i.pick();
                    }}
                  >
                    <Icon name={i.icon} size={16} />
                    <span className="ellipsis">{i.label}</span>
                    {i.sub && <span className="sub">{i.sub}</span>}
                  </a>
                );
              })}
            </div>
          ))}
        </div>
        <div className="palette-foot">
          <span><kbd>↑</kbd> <kbd>↓</kbd> move</span>
          <span><kbd>Enter</kbd> open</span>
          <span><kbd>Ctrl</kbd> <kbd>K</kbd> or <kbd>/</kbd> from anywhere</span>
        </div>
      </div>
    </div>
  );
}

// ---- the sidebar (wide screens) ----
function Sidebar({ route, version, fired, pins, refresh, theme, openPalette }) {
  const isOn = (id) => route.page === id;
  return (
    <aside className="side" aria-label="Pages">
      <a className="brand" href={href("home")} aria-label="NetLens home">
        <span className="brand-mark" aria-hidden="true" />
        <strong>NetLens</strong>
        {version && <small>{/^\d/.test(version) ? `v${version}` : version}</small>}
      </a>
      <button className="side-search" onClick={openPalette}>
        <Icon name="search" size={15} />
        <span>Find anything</span>
        <kbd>Ctrl K</kbd>
      </button>
      <nav aria-label="Views">
        {GROUPS.map((g) => (
          <div key={g.id}>
            {g.label && <div className="side-group">{g.label}</div>}
            {g.items.map(([id, label, icon]) => (
              <a
                key={id}
                className={`nav ${isOn(id) || (id === "devices" && route.page === "device" && !pins?.some((p) => p.mac === String(route.arg).toLowerCase())) ? "on" : ""}`}
                href={href(id)}
                aria-current={isOn(id) ? "page" : undefined}
              >
                <Icon name={icon} />
                {label}
                {id === "alerts" && fired > 0 && <span className="count" title={`${fired} reached today`}>{fired}</span>}
              </a>
            ))}
            {g.id === "devices" &&
              (pins || []).map((p) => (
                <a key={p.mac} className={`nav pinned ${route.page === "device" && String(route.arg).toLowerCase() === p.mac ? "on" : ""}`} href={href("device", p.mac)} title={`${p.name} (pinned)`}>
                  <span className="dot" aria-hidden="true" />
                  <span className="pin-name">{p.name}</span>
                </a>
              ))}
          </div>
        ))}
      </nav>
      <div className="side-foot">
        <a className={`nav ${isOn("settings") ? "on" : ""}`} href={href("settings")}>
          <Icon name="settings" />
          Settings
        </a>
        <button className="nav" onClick={theme.next} title="Switch theme">
          <Icon name={THEME_ICON[theme.choice]} />
          {THEME_WORD[theme.choice]}
        </button>
        <div className="side-status" title={refresh.err ? `Refresh failed: ${refresh.err}` : "NetLens reads UniFi every 5 minutes"}>
          <span className={`status-dot ${refresh.err ? "bad" : ""}`} />
          <span>{refresh.busy ? "Updating…" : `Updated ${ago(refresh.last)}`}</span>
          <RefreshButton r={refresh} />
        </div>
      </div>
    </aside>
  );
}

// ---- phones: a bottom bar with the main areas, and a sheet with every page ----
function BottomNav({ route, fired, onMore }) {
  const g = groupOf(route.page)?.id || (route.page === "settings" ? "more" : "home");
  const items = [
    ["home", "Overview", "home", href("home")],
    ["activity", "Activity", "timeline", href(lastActivity())],
    ["devices", "Devices", "devices", href("devices")],
    ["network", "Network", "map", href("network")],
  ];
  return (
    <nav className="bottomnav" aria-label="Main areas">
      {items.map(([id, label, icon, to]) => (
        <a key={id} href={to} className={g === id ? "on" : ""}>
          <Icon name={icon} size={20} />
          {label}
        </a>
      ))}
      <button className={g === "protection" || g === "more" ? "on" : ""} onClick={onMore} aria-label={fired > 0 ? `More, ${fired} limits reached today` : "More"}>
        <Icon name="more" size={20} />
        More
        {fired > 0 && <span className="count">{fired}</span>}
      </button>
    </nav>
  );
}
function MoreSheet({ route, fired, pins, theme, onClose }) {
  useEffect(() => {
    const esc = (e) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);
  const link = (id, label, icon, to = href(id)) => (
    <a key={id + to} href={to} className={route.page === id ? "on" : ""} onClick={onClose}>
      <Icon name={icon} />
      <span className="ellipsis">{label}</span>
      {id === "alerts" && fired > 0 && <span className="count" style={{ marginLeft: "auto" }}>{fired}</span>}
    </a>
  );
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-label="All pages">
        <div className="grabber" aria-hidden="true" />
        {GROUPS.map((g) => (
          <div key={g.id}>
            <div className="side-group">{g.label || "Home"}</div>
            <div className="sheet-grid">
              {g.items.map(([id, label, icon]) => link(id, label, icon))}
              {g.id === "devices" && (pins || []).map((p) => link("device", p.name, "star", href("device", p.mac)))}
            </div>
          </div>
        ))}
        <div className="side-group">NetLens</div>
        <div className="sheet-grid">
          {link("settings", "Settings", "settings")}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              theme.next();
            }}
          >
            <Icon name={THEME_ICON[theme.choice]} />
            <span className="ellipsis">{THEME_WORD[theme.choice]}</span>
          </a>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const route = useRoute();
  const version = useVersion();
  const fired = useFiredToday(route.page);
  const updating = usePending();
  const pins = usePins();
  const theme = useTheme();
  const [palette, setPalette] = useState(false);
  const [more, setMore] = useState(false);
  // Bumped by Refresh: remounts the page so it loads everything again.
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useRefresh(() => setRefreshKey((k) => k + 1));
  const Page = PAGES[route.page] || PAGES.home;
  const group = groupOf(route.page);

  useEffect(() => {
    window.scrollTo(0, 0);
    setMore(false);
  }, [route.page, route.arg]);
  useEffect(() => {
    if (group?.id !== "activity") return;
    try {
      localStorage.setItem(LAST_ACTIVITY, route.page);
    } catch {
      /* remembered for this visit only */
    }
  }, [route.page, group]);
  useEffect(() => {
    document.title = `${pageLabel(route.page) || "Overview"} · NetLens`;
  }, [route.page]);
  // Ctrl+K / Cmd+K, or / when not typing, opens the palette.
  useEffect(() => {
    const on = (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName) || e.target?.isContentEditable;
      if ((e.key === "k" || e.key === "K") && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setPalette((v) => !v);
      } else if (e.key === "/" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setPalette(true);
      }
    };
    document.addEventListener("keydown", on);
    return () => document.removeEventListener("keydown", on);
  }, []);

  const deviceMac = route.page === "device" && route.arg ? String(route.arg).toLowerCase() : null;
  const pinnedHere = deviceMac && pins?.some((p) => p.mac === deviceMac);
  const actions = useMemo(
    () => [
      { key: "x-refresh", label: "Refresh data now", sub: "read UniFi now", icon: "refresh", run: refresh.run },
      { key: "x-theme-system", label: "Theme: follow this device", icon: "auto", run: () => theme.pick("system") },
      { key: "x-theme-light", label: "Theme: light", icon: "sun", run: () => theme.pick("light") },
      { key: "x-theme-dark", label: "Theme: dark", icon: "moon", run: () => theme.pick("dark") },
      ...(deviceMac ? [{ key: "x-pin", label: pinnedHere ? "Unpin this device" : "Pin this device to the sidebar", icon: "star", run: () => setPinned(deviceMac, !pinnedHere).catch(() => {}) }] : []),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deviceMac, pinnedHere, refresh.busy, theme.choice]
  );

  return (
    <div className="app">
      <Sidebar route={route} version={version} fired={fired} pins={pins} refresh={refresh} theme={theme} openPalette={() => setPalette(true)} />
      <div className="main-col">
        <header className="topbar">
          <a className="brand" href={href("home")} aria-label="NetLens home">
            <span className="brand-mark" aria-hidden="true" />
            <strong>NetLens</strong>
          </a>
          <div className="crumb">
            {group?.label && <span>{group.label}</span>}
            {group?.label && <span aria-hidden="true">›</span>}
            <strong>{pageLabel(route.page) || "Overview"}</strong>
          </div>
          <span className="spacer" />
          <button className="top-search" onClick={() => setPalette(true)} aria-label="Find anything">
            <Icon name="search" size={16} />
            <span>Find a page, device or app</span>
            <kbd>/</kbd>
          </button>
          <span className="only-phone">
            <RefreshButton r={refresh} />
          </span>
          {/* A new period or filter is loading; the numbers below are the old ones (UU-C-202). */}
          {updating && (
            <div className="updating" role="status">
              <span className="updating-bar" aria-hidden="true" />
              <span className="updating-note">Updating…</span>
            </div>
          )}
        </header>
        {group && group.items.length > 1 && (
          <nav className="subtabs" aria-label={group.label}>
            {group.items.map(([id, label]) => (
              <a key={id} href={href(id, null, group.id === "activity" && route.query.d ? { d: route.query.d } : null)} className={route.page === id ? "on" : ""}>
                {label}
              </a>
            ))}
          </nav>
        )}
        <main className={updating ? "page-wrap stale" : "page-wrap"} aria-busy={updating}>
          <Suspense fallback={<Loading />}>
            <Page key={refreshKey} route={route} version={version} />
          </Suspense>
        </main>
      </div>
      <BottomNav route={route} fired={fired} onMore={() => setMore(true)} />
      {more && <MoreSheet route={route} fired={fired} pins={pins} theme={theme} onClose={() => setMore(false)} />}
      {palette && <Palette onClose={() => setPalette(false)} actions={actions} />}
    </div>
  );
}
