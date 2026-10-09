import { useEffect, useMemo, useRef, useState } from "react";
import SideNav from "./shared/SideNav.jsx";
import { useViewHistory } from "./shared/useViewHistory.js";
import { GatewayStrip, InsightsPage, PageTabs } from "./Insights.jsx";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const isDesktop = Boolean(typeof window !== "undefined" && window.unifiDesktop?.isDesktop);

// Recharts takes colour literals, not CSS variables, so these mirror styles.css.
// Change both together. COLORS must stay defined — losing it once unmounted the whole
// React tree a second after the report painted.
const CHART = {
  grid: "#242d3e",
  axis: "#8a96ab",
  bar: "#38bdf8",
  tooltipBg: "#131823",
  tooltipLine: "#242d3e",
  lost: "#7f1d1d",
};

// Consecutive timeline labels that are mostly lost, as [firstLabel, lastLabel] runs for
// shading the chart.
function lostRuns(timeline) {
  const runs = [];
  let open = null;
  for (const b of timeline) {
    // Red marks time where nothing survives. A day with UniFi daily totals (grey bar) is not
    // empty, so it is not shaded (UU-C-057).
    if (b.lost >= 0.5 && !b.fillBytes) {
      if (open) open[1] = b.label;
      else open = [b.label, b.label];
    } else if (open) {
      runs.push(open);
      open = null;
    }
  }
  if (open) runs.push(open);
  return runs;
}

// "Jul 11 – Sep 11, Sep 24 – 27 (65 whole days), Sep 28 12:00 AM – 7:00 PM". Whole days are
// grouped into runs of consecutive days; a month is repeated only when it changes.
function describeLost(spans) {
  const day = (sp) => sp.at.split(",")[0];
  const time = (s) => s.split(", ").slice(1).join(", ").replace(/:00(?= [AP]M)/, "");
  const next = (key) => {
    const d = new Date(`${key}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  };
  const whole = spans.filter((sp) => sp.whole).sort((a, b) => a.dayKey.localeCompare(b.dayKey));
  const runs = [];
  for (const sp of whole) {
    const last = runs[runs.length - 1];
    if (last && next(last.endKey) === sp.dayKey) {
      last.endKey = sp.dayKey;
      last.end = day(sp);
    } else runs.push({ endKey: sp.dayKey, start: day(sp), end: day(sp) });
  }
  const label = (r) => {
    if (r.start === r.end) return r.start;
    const [m1] = r.start.split(" ");
    const [m2, d2] = r.end.split(" ");
    return `${r.start} – ${m1 === m2 ? d2 : `${m2} ${d2}`}`;
  };
  const parts = [];
  if (runs.length) parts.push(`${runs.map(label).join(", ")} (${whole.length} whole ${whole.length === 1 ? "day" : "days"})`);
  for (const sp of spans.filter((x) => !x.whole)) parts.push(`${day(sp)} ${time(sp.at)} – ${time(sp.endAt)}`);
  return parts.join(", ");
}
const COLORS = ["#38bdf8", "#2dd4bf", "#a78bfa", "#fbbf24", "#fb7185", "#4ade80", "#f472b6", "#60a5fa"];

function formatDuration(sec) {
  const s = Number(sec) || 0;
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

function formatCacheAge(ts) {
  const s = Math.max(0, Math.round((Date.now() - Number(ts)) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h === 1 ? "1 hour ago" : `${h} hours ago`;
}

function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  return `${x.toFixed(x >= 10 ? 1 : 2)} ${units[i]}`;
}

async function api(path, opts) {
  const root =
    window.location.protocol === "file:" || window.unifiDesktop?.isDesktop
      ? "http://127.0.0.1:3780"
      : "";
  const res = await fetch(`${root}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const json = await res.json();
  if (!res.ok) {
    // UniFi puts the useful part in the body; surfacing only `error` hid
    // "valid values: AUTHORIZE_GUEST_ACCESS..." for the whole life of the block bug.
    const detail = json.detail?.message || json.detail?.meta?.msg;
    throw new Error(detail ? `${json.error || res.statusText} — ${detail}` : json.error || res.statusText);
  }
  return json;
}

export default function App() {
  const [scope, setScope] = useState("online");
  const [clients, setClients] = useState([]);
  const [categories, setCategories] = useState([]);
  const [selected, setSelected] = useState("all");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [period, setPeriod] = useState("today");
  const [date, setDate] = useState("");
  const [category, setCategory] = useState("all");
  const [appId, setAppId] = useState("all");
  const [appOptions, setAppOptions] = useState([]);
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [cacheInfo, setCacheInfo] = useState(null);
  const [busyBlock, setBusyBlock] = useState(false);
  const [menu, setMenu] = useState(null);
  const [navOpen, setNavOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState({ host: "", apiKey: "", site: "default" });
  const [hasApiKey, setHasApiKey] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [trayMode, setTrayMode] = useState(false);
  // Usage (the original dashboard), Wi-Fi, Equipment, Threats (UU-C-056).
  const [page, setPage] = useState("usage");
  const [siemStatus, setSiemStatus] = useState(null);
  // Back undoes the last filter change. `query` is remembered so the device box shows the
  // right name again, but not tracked — every keystroke would otherwise be a step.
  const { canGoBack, back } = useViewHistory(
    { scope, selected, query, period, date, category, appId, page },
    (v) => {
      setPage(v.page || "usage");
      setScope(v.scope);
      setSelected(v.selected);
      setQuery(v.query);
      setPeriod(v.period);
      setDate(v.date);
      setCategory(v.category);
      setAppId(v.appId);
    },
    ["scope", "selected", "period", "date", "category", "appId", "page"]
  );

  const selectedClient = clients.find((c) => c.mac === selected);

  // Every control that narrows the report, with its default. Keep this in step with the
  // state declarations above, or Reset will silently miss a filter.
  const FILTER_DEFAULTS = { scope: "online", selected: "all", query: "", period: "today", date: "", category: "all", appId: "all" };
  const filtersActive =
    scope !== FILTER_DEFAULTS.scope ||
    selected !== FILTER_DEFAULTS.selected ||
    query !== FILTER_DEFAULTS.query ||
    period !== FILTER_DEFAULTS.period ||
    date !== FILTER_DEFAULTS.date ||
    category !== FILTER_DEFAULTS.category ||
    appId !== FILTER_DEFAULTS.appId;

  function resetFilters() {
    setScope(FILTER_DEFAULTS.scope);
    setSelected(FILTER_DEFAULTS.selected);
    setQuery(FILTER_DEFAULTS.query);
    setPeriod(FILTER_DEFAULTS.period);
    setDate(FILTER_DEFAULTS.date);
    setCategory(FILTER_DEFAULTS.category);
    setAppId(FILTER_DEFAULTS.appId);
    setOpen(false);
  }

  // Built from what this device actually used in this window (server: appChoices),
  // busiest first, not from a hardcoded list of streaming brands. `appOptions` from
  // /api/apps is only a fallback for the first paint before a report arrives.
  const appChoices = useMemo(() => {
    const byName = new Map();
    const add = (id, name, bytes, source, infrastructure) => {
      const label = String(name || "").trim();
      if (!label) return;
      const key = label.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "");
      if (!key) return;
      const prev = byName.get(key);
      if (!prev || (bytes || 0) > (prev.bytes || 0)) byName.set(key, { id, name: label, bytes: bytes || 0, source, infrastructure });
    };
    const choices = report?.appChoices;
    if (choices?.length) {
      for (const a of choices) add(a.value ?? a.appId, a.app, a.totalBytes, a.source, a.infrastructure);
    } else {
      for (const a of appOptions) add(String(a.id), a.name, 0, "unifi");
    }
    // Keep the selection reachable even if it drops out of scope, so the picker never
    // shows a value that is not in its own list.
    if (appId !== "all" && ![...byName.values()].some((c) => String(c.id) === String(appId))) {
      const sel = report?.apps?.find((a) => String(a.appId) === String(appId));
      if (sel) add(String(sel.appId), sel.app, sel.totalBytes, "unifi");
    }
    // The server caps the list by traffic so the 60 that survive are the relevant ones;
    // display them alphabetically, which is how you look something up in a dropdown.
    return [...byName.values()].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    );
  }, [appOptions, report, appId]);

  // Bounds come from the server, which owns `tz` and `retainDays`. Deriving them here
  // from the browser clock sliced an ISO string in UTC and put "today" a day ahead
  // after 20:00 America/New_York.
  const dateBounds = {
    min: cacheInfo?.oldestRetainedKey,
    max: cacheInfo?.todayKey,
  };

  const filteredClients = useMemo(() => {
    const q = query.trim().toLowerCase();
    return clients.filter((c) => {
      if (!q) return true;
      return [c.name, c.hostname, c.mac, c.ip].filter(Boolean).join(" ").toLowerCase().includes(q);
    });
  }, [clients, query]);

  async function loadClients() {
    const data = await api(`/api/clients?scope=${scope}`);
    setClients(data.clients);
    setCategories(data.categories || []);
  }

  async function loadReport() {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({
        period,
        category,
      });
      if (selected !== "all") params.set("mac", selected);
      if (appId !== "all") params.set("appId", appId);
      if (period === "custom" && date) params.set("date", date);
      const data = await api(`/api/report?${params}`);
      setReport(data);
      if (data.cachedAt) {
        setCacheInfo((cur) => ({ ...(cur || {}), fetchedAt: data.cachedAt, ready: true, warming: false }));
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function fetchNewData() {
    setLoading(true);
    setError("");
    try {
      await api("/api/cache/delta", {
        method: "POST",
        body: JSON.stringify({ period, date }),
      });
      await loadClients();
      await loadReport();
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  }

  // Only reachable when /api/cache reports gaps, i.e. the app was closed for longer
  // than the automatic fetch window and some days in between were never pulled.
  async function backfillGaps() {
    const n = cacheInfo?.gaps?.length || 0;
    if (!n) return;
    if (!window.confirm(`Fetch ${n} missing day${n === 1 ? "" : "s"} from UniFi? Older days may no longer exist on the console.`)) return;
    setLoading(true);
    setError("");
    try {
      await api("/api/cache/backfill", { method: "POST", body: "{}" });
      await loadReport();
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  }

  async function refetchAllData() {
    if (!window.confirm("Re-download today, yesterday, and the last 7 days from UniFi? This can take a while.")) return;
    setLoading(true);
    setError("");
    try {
      await api("/api/cache/refetch", { method: "POST", body: "{}" });
      await loadClients();
      await loadReport();
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  }

  useEffect(() => {
    loadClients().catch((err) => setError(err.message));
    api("/api/apps")
      .then((data) => setAppOptions(data.apps || []))
      .catch(() => {});
  }, [scope]);

  useEffect(() => {
    loadReport().catch((err) => setError(err.message));
  }, [selected, period, date, category, appId]);

  useEffect(() => {
    api("/api/settings")
      .then((data) => setTrayMode(Boolean(data.trayMode)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let timer;
    let stopped = false;
    async function tick() {
      try {
        const data = await api("/api/cache");
        if (!stopped) setCacheInfo(data);
        timer = setTimeout(tick, data.warming ? 1200 : 10000);
      } catch {
        timer = setTimeout(tick, 4000);
      }
    }
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    api("/api/settings")
      .then((data) => setTrayMode(Boolean(data.trayMode)))
      .catch(() => {});
  }, []);

  // The menu listener can only be registered once, but loadReport and friends read
  // period / category / selected / appId / date straight from the render closure. A
  // plain [] effect would freeze them at first render, so every native-menu action
  // redrew the report as today / whole network / all apps. Route through a ref that
  // each render refreshes.
  const menuHandlers = useRef(null);
  menuHandlers.current = { openSettings, loadClients, loadReport, fetchNewData, refetchAllData, backfillGaps };

  useEffect(() => {
    if (!window.unifiDesktop?.onMenu) return undefined;
    return window.unifiDesktop.onMenu((action) => {
      const h = menuHandlers.current;
      if (!h) return;
      const fail = (err) => setError(err.message);
      if (action === "settings") h.openSettings();
      if (action === "refresh" || action === "reload") {
        h.loadClients().catch(fail);
        h.loadReport().catch(fail);
      }
      if (action === "fetch-new") h.fetchNewData().catch(fail);
      if (action === "refetch-all") h.refetchAllData().catch(fail);
      if (action === "backfill") h.backfillGaps().catch(fail);
      if (action === "tray-sync") {
        api("/api/settings")
          .then((data) => setTrayMode(Boolean(data.trayMode)))
          .catch(() => {});
      }
    });
  }, []);

  async function toggleBlock() {
    if (!selectedClient?.mac) return;
    const next = !selectedClient.blocked;
    const verb = next ? "block" : "unblock";
    if (!window.confirm(`${verb} ${selectedClient.name} on the UniFi console?`)) return;
    setBusyBlock(true);
    try {
      await api(`/api/clients/${encodeURIComponent(selectedClient.mac)}/block`, {
        method: "POST",
        body: JSON.stringify({ blocked: next }),
      });
      await loadClients();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyBlock(false);
    }
  }

  async function openSettings() {
    setMenu(null);
    try {
      const data = await api("/api/settings");
      // The server no longer returns the key, only whether one is stored.
      setHasApiKey(Boolean(data.hasApiKey));
      setSettings({
        host: data.host || "",
        apiKey: "",
        site: data.site || "default",
        siemPort: data.siemPort || "",
      });
    } catch {
      setHasApiKey(false);
      setSettings({ host: "", apiKey: "", site: "default", siemPort: "" });
    }
    api("/api/siem")
      .then(setSiemStatus)
      .catch(() => setSiemStatus(null));
    setSettingsOpen(true);
  }

  async function saveSettings(e) {
    e.preventDefault();
    setSettingsBusy(true);
    setError("");
    try {
      // Blank means "keep the stored key" — PUT ignores an empty apiKey.
      const payload = { ...settings, trayMode };
      if (!payload.apiKey) delete payload.apiKey;
      await api("/api/settings", { method: "PUT", body: JSON.stringify(payload) });
      setSettingsOpen(false);
      await loadClients();
      await loadReport();
    } catch (err) {
      setError(err.message);
    } finally {
      setSettingsBusy(false);
    }
  }

  async function setBackground(enabled, hide) {
    setMenu(null);
    setTrayMode(enabled);
    try {
      await api("/api/app/tray", {
        method: "POST",
        body: JSON.stringify({ enabled, hide: Boolean(hide) }),
      });
      window.unifiDesktop?.setTrayMode?.(enabled);
      if (hide) window.unifiDesktop?.hideToTray?.();
    } catch (err) {
      setError(err.message);
    }
  }

  async function quitApp() {
    setMenu(null);
    if (window.unifiDesktop?.quit) {
      await window.unifiDesktop.quit();
      return;
    }
    try {
      await api("/api/shutdown", { method: "POST" });
    } catch {
      /* host closes the window */
    }
  }

  const maxApp = report?.apps?.[0]?.totalBytes || 1;
  const label = selected === "all" ? "Whole network" : selectedClient?.name || selected;
  const focusedApp =
    appId !== "all"
      ? report?.apps?.find((a) => String(a.appId) === String(appId)) ||
        appChoices.find((a) => String(a.id) === String(appId))
      : null;
  const focusedName = focusedApp?.app || focusedApp?.name;
  const chartTitle =
    focusedName && report?.grain === "hour"
      ? `${focusedName} by hour`
      : focusedName
        ? `${focusedName} by day`
        : report?.grain === "hour"
          ? "Usage by hour"
          : "Usage by day";

  return (
    <div className="shell">
      <SideNav
        open={navOpen}
        onClose={() => setNavOpen(false)}
        view="classic"
        warming={Boolean(cacheInfo?.warming)}
        statusText={
          cacheInfo?.warming
            ? "Gathering data…"
            : cacheInfo?.fetchedAt
              ? `Cached ${formatCacheAge(cacheInfo.fetchedAt)}`
              : "No cache yet"
        }
        gaps={cacheInfo?.gaps?.length || 0}
        busy={loading}
        onFetchNew={fetchNewData}
        onBackfill={backfillGaps}
        onRefetchAll={refetchAllData}
        onReload={() => { loadClients(); loadReport(); }}
        onOpenSettings={openSettings}
        trayMode={trayMode}
        // Desktop-only: in the Docker web UI there is no tray, and "Exit" would stop the
        // container for everyone (the server refuses it in server mode anyway).
        onToggleTray={isDesktop ? (next) => setBackground(next, false) : undefined}
        onMinimize={isDesktop ? () => setBackground(true, true) : undefined}
        onQuit={isDesktop ? quitApp : undefined}
      />

      <div className="main">
      {settingsOpen && (
        <div className="modal-back" onClick={() => setSettingsOpen(false)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={saveSettings}>
            <h2>UniFi connection</h2>
            <label>
              UniFi IP or hostname
              <input
                value={settings.host}
                onChange={(e) => setSettings({ ...settings, host: e.target.value })}
                placeholder="192.168.1.1"
                required
              />
            </label>
            <label>
              API key
              <input
                type="password"
                value={settings.apiKey}
                onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })}
                placeholder={hasApiKey ? "Stored — leave blank to keep" : "UniFi API key"}
                required={!hasApiKey}
              />
            </label>
            <label>
              Site
              <input
                value={settings.site}
                onChange={(e) => setSettings({ ...settings, site: e.target.value })}
                placeholder="default"
              />
            </label>
            <h3 style={{ margin: "14px 0 4px" }}>Blocked-ad statistics (optional)</h3>
            <p className="muted" style={{ margin: "0 0 8px" }}>
              Device connects, disconnects, roams and threats come from UniFi's System Log automatically — nothing to
              set up. Only ad-block counts need your syslog-ng server, forwarding UniFi's SIEM export to this PC on the
              port below. Leave it blank if you don't want them.
            </p>
            <label>
              Listen on port
              <input
                inputMode="numeric"
                value={settings.siemPort || ""}
                onChange={(e) => setSettings({ ...settings, siemPort: e.target.value.replace(/\D/g, "") })}
                placeholder="e.g. 5514 — blank to turn off"
              />
            </label>
            {siemStatus && siemStatus.port && (
              <p className="muted" style={{ margin: "4px 0 0" }}>
                {siemStatus.systemLog?.lastPulledAt
                  ? `System Log pulled ${new Date(siemStatus.systemLog.lastPulledAt).toLocaleString()} · `
                  : ""}
                {siemStatus.error
                  ? `Problem: ${siemStatus.error}`
                  : siemStatus.listening
                    ? `Listening on port ${siemStatus.port}${siemStatus.lastReceivedAt ? ` · last message ${new Date(siemStatus.lastReceivedAt).toLocaleString()}` : " · nothing received yet"}`
                    : `Not listening on port ${siemStatus.port}`}
                {` · ${siemStatus.events} events stored`}
              </p>
            )}
            <div className="actions">
              <button type="button" className="btn ghost" onClick={() => setSettingsOpen(false)}>
                Cancel
              </button>
              <button type="submit" className="btn" disabled={settingsBusy}>
                {settingsBusy ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        </div>
      )}

    <div className="app">
      <div className="header">
        <div className="header-title">
          <button className="nav-toggle" onClick={() => setNavOpen((v) => !v)} aria-label="Menu">
            <span />
            <span />
            <span />
          </button>
          <div>
            <h1>UniFi NetLens</h1>
            <p>Traffic, Wi-Fi, equipment and security for your UniFi network</p>
          </div>
        </div>
        <div className="header-actions">
        <button className="btn ghost" disabled={!canGoBack} onClick={back} title="Back (Alt+←)">
          ← Back
        </button>
        {selected !== "all" && selectedClient?.mac && (
          <button className={selectedClient.blocked ? "btn ghost" : "btn danger"} disabled={busyBlock} onClick={toggleBlock}>
            {busyBlock ? "Updating…" : selectedClient.blocked ? "Unblock device" : "Block device"}
          </button>
        )}
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      <GatewayStrip api={api} />
      <PageTabs page={page} setPage={setPage} />

      <div className="controls">
        <div className="field search-wrap">
          <label>Device</label>
          <input
            className="search"
            value={open ? query : selected === "all" ? "Whole network" : selectedClient?.name || query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onFocus={() => {
              setOpen(true);
              setQuery("");
            }}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            placeholder="Search devices"
          />
          {open && (
            <div className="search-list">
              <button
                className={selected === "all" ? "active" : ""}
                onClick={() => {
                  // Keep the app filter: switching device narrows the same question
                  // rather than resetting it. Clearing it here meant picking a service
                  // and then a device silently showed that device's entire traffic.
                  setSelected("all");
                  setOpen(false);
                }}
              >
                Whole network
              </button>
              {filteredClients.map((c) => (
                <button
                  key={c.mac}
                  className={selected === c.mac ? "active" : ""}
                  onClick={() => {
                    setSelected(c.mac);
                    setQuery("");
                    setOpen(false);
                  }}
                >
                  <span className={`dot ${c.online ? "on" : "off"}`} />
                  {c.name || c.mac}
                  <span className="muted"> · {c.ip || c.mac}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="field">
          <label>Show</label>
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="online">Online now</option>
            <option value="known">All known</option>
          </select>
        </div>
        <div className="field">
          <label>When</label>
          <select value={period} onChange={(e) => setPeriod(e.target.value)}>
            <option value="today">Today</option>
            <option value="yesterday">Yesterday</option>
            <option value="7d">Last 7 days</option>
            <option value="14d">Last 14 days</option>
            <option value="30d">Last 30 days</option>
            <option value="90d">Last 90 days</option>
            <option value="custom">Pick a day</option>
          </select>
        </div>
        <div className="field">
          <label>Category</label>
          <select
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
              setAppId("all");
            }}
          >
            <option value="all">All categories</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>App</label>
          <select value={appId} onChange={(e) => setAppId(e.target.value)}>
            <option value="all">All apps</option>
            {appChoices.map((a) => (
              <option
                key={a.name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "") || String(a.id)}
                value={a.id}
              >
                {a.name}
              </option>
            ))}
          </select>
        </div>
        {period === "custom" ? (
          <div className="field">
            <label>Date</label>
            <input
              type="date"
              value={date}
              min={dateBounds.min}
              max={dateBounds.max}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
        ) : null}
        <div className="field">
          <label>&nbsp;</label>
          <button
            type="button"
            className="btn ghost"
            onClick={resetFilters}
            disabled={!filtersActive}
            title={filtersActive ? "Back to today, whole network, all apps" : "Nothing to reset"}
          >
            Reset filters
          </button>
        </div>
      </div>

      {page !== "usage" && (
        <InsightsPage page={page} api={api} period={period} date={date} selected={selected} setSelected={setSelected} />
      )}

      {page === "usage" && (
      <>
      <div className="stats">
        <div className="card">
          <div className="stat-label">Scope</div>
          <div className="stat-value">{label}</div>
        </div>
        <div className="card">
          <div className="stat-label">
            Total
            {report?.basis === "flows" ? " · connection records" : ""}
          </div>
          <div className="stat-value">{formatBytes(report?.totals?.bytes)}</div>
        </div>
        <div className="card">
          <div className="stat-label">Download</div>
          <div className="stat-value">{formatBytes(report?.totals?.rx)}</div>
        </div>
        <div className="card">
          <div className="stat-label">Upload</div>
          <div className="stat-value">{formatBytes(report?.totals?.tx)}</div>
        </div>
        {report?.localBytes > 0 && (
          <div className="card">
            <div className="stat-label">Local network</div>
            <div className="stat-value">{formatBytes(report.localBytes)}</div>
            <div className="muted">not counted by UniFi · from connection records</div>
          </div>
        )}
      </div>

      {loading && <div className="loading">Loading UniFi traffic…</div>}

      {report && (
        <>
          <div className="charts">
            <div className="card">
              <div className="row">
                <h3>{chartTitle}</h3>
                <span className="muted">
                  {appId !== "all" ? (
                    <button className="btn ghost" onClick={() => setAppId("all")}>
                      Show all apps
                    </button>
                  ) : (
                    `${report.timeline?.length || 0} buckets · click an app for times`
                  )}
                </span>
              </div>
              {appId !== "all" && (
                <p className="muted" style={{ marginTop: 0 }}>
                  {report?.basis === "flows"
                    ? report?.categories?.[0]?.category === "Local network"
                      ? `${focusedName || "This service"} is on your own network. UniFi's usage counters only cover internet traffic, so everything here — chart, sessions and total — comes from connection records.`
                      : `UniFi does not identify ${focusedName || "this service"}, so everything here comes from its connection records.`
                    : "Everything on this page is UniFi's own traffic count for this app, so the chart, the table and the sessions add up to the total above."}
                </p>
              )}
              {(report?.lostSpans || []).length > 0 && (
                <div className="lost-note">
                  <strong>Missing data.</strong> UniFi had already deleted the detail before the app saved it (UniFi keeps
                  usage for 7 days and connection records for about 4): {describeLost(report.lostSpans)}.
                  {report.dailyFill?.totalBytes > 0
                    ? ` UniFi's daily report still has per-device totals for these days: ${formatBytes(report.dailyFill.totalBytes)}${
                        report.grain === "day" ? ", drawn in grey" : ""
                      } — no apps, hours or sessions, and not part of the totals above.`
                    : " Totals on this page cover only what was saved."}
                </div>
              )}
              {report?.unplacedBytes > 0.002 * (report?.totals?.bytes || 0) && (
                <p className="muted" style={{ marginTop: 0 }}>
                  {formatBytes(report.unplacedBytes)} of the {formatBytes(report.totals.bytes)} is not drawn: it is counted,
                  but UniFi no longer had hourly detail for it when it was saved. The total is exact; only when it
                  happened is unknown.
                </p>
              )}
              <div style={{ height: 280 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={report.timeline || []}>
                    <CartesianGrid stroke={CHART.grid} vertical={false} />
                    <XAxis dataKey="label" stroke={CHART.axis} />
                    <YAxis stroke={CHART.axis} tickFormatter={(v) => formatBytes(v)} width={72} />
                    <Tooltip formatter={(v) => formatBytes(v)} contentStyle={{ background: CHART.tooltipBg, border: `1px solid ${CHART.tooltipLine}`, borderRadius: 10 }} />
                    {lostRuns(report.timeline || []).map(([a, b]) => (
                      <ReferenceArea key={a} x1={a} x2={b} fill={CHART.lost} fillOpacity={0.35} ifOverflow="extendDomain" />
                    ))}
                    <Bar dataKey="totalBytes" name="Saved" stackId="day" fill={CHART.bar} radius={[6, 6, 0, 0]} />
                    {report?.dailyFill?.totalBytes > 0 && (
                      <Bar dataKey="fillBytes" name="Device totals only (UniFi daily report)" stackId="day" fill="#64748b" radius={[6, 6, 0, 0]} />
                    )}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="card">
              <h3>By category</h3>
              <div style={{ height: 280 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={report.categories?.slice(0, 8) || []} dataKey="totalBytes" nameKey="category" innerRadius={50} outerRadius={90}>
                      {(report.categories || []).slice(0, 8).map((_, i) => (
                        <Cell key={i} fill={COLORS[i % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(v) => formatBytes(v)} contentStyle={{ background: CHART.tooltipBg, border: `1px solid ${CHART.tooltipLine}`, borderRadius: 10 }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          <div className="card apps-card">
              <h3>Apps</h3>
              <p className="muted">Click an app name to see when it was used.</p>
              <table>
                <thead>
                  <tr>
                    <th>Application</th>
                    <th>Category</th>
                    <th>Active</th>
                    <th>Traffic</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {(report.apps || []).slice(0, 25).map((a) => (
                    <tr key={a.appId} className={String(appId) === String(a.appId) ? "row-active" : ""}>
                      <td>
                        <button
                          type="button"
                          className={String(appId) === String(a.appId) ? "btn" : "btn ghost"}
                          onClick={(e) => {
                            e.stopPropagation();
                            setAppId(String(appId) === String(a.appId) ? "all" : String(a.appId));
                          }}
                        >
                          {a.app}
                        </button>
                      </td>
                      <td className="muted">
                        {a.category}
                        {(a.topDevices || []).length ? (
                          <div className="muted">{a.topDevices.map((d) => d.name).join(", ")}</div>
                        ) : null}
                      </td>
                      <td className="muted">
                        {a.activitySeconds != null ? formatDuration(a.activitySeconds) : "—"}
                        <div className="muted">{a.source === "flows" ? "not measured" : "UniFi active time"}</div>
                      </td>
                      <td>
                        {formatBytes(a.totalBytes)}
                      </td>
                      <td>
                        <div className="bar">
                          <span style={{ width: `${Math.max(4, (a.totalBytes / maxApp) * 100)}%` }} />
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!(report.apps || []).length && (
                    <tr>
                      <td colSpan="4" className="muted">No matched traffic in this window.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

          <div className="split">
            <div className="card">
              <h3>{selected === "all" ? "Top devices" : "Client"}</h3>
              {selected === "all" ? (
                <table>
                  <thead>
                    <tr>
                      <th>Device</th>
                      <th>Traffic</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(report.clients || []).slice(0, 20).map((c) => (
                      <tr key={c.mac}>
                        <td>
                          <button className="btn ghost" onClick={() => setSelected(c.mac)}>
                            {c.name || c.mac}
                          </button>
                        </td>
                        <td>{formatBytes(c.totalBytes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="muted">
                  {selectedClient?.ip || "No IP"} · {selectedClient?.mac}
                  <br />
                  {selectedClient?.online ? "Online" : "Known / not currently reported online"}
                  {selectedClient?.blocked ? " · Blocked" : ""}
                </p>
              )}
            </div>

            {report?.localServices?.length > 0 && (
              <div className="card">
                <h3>Local network</h3>
                <p className="muted" style={{ marginTop: 0 }}>
                  Traffic between your own devices — a media server, a NAS. It never reaches the internet, so UniFi's
                  usage counters do not include it and it is not part of the totals above. These figures come from
                  connection records. Click one to see when it was used.
                </p>
                <table>
                  <thead>
                    <tr>
                      <th>Service</th>
                      <th>Device</th>
                      <th>Traffic</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {report.localServices.map((l) => (
                      <tr key={l.value} className={appId === l.value ? "row-active" : ""}>
                        <td>
                          <button
                            type="button"
                            className={appId === l.value ? "btn" : "btn ghost"}
                            onClick={() => setAppId(appId === l.value ? "all" : l.value)}
                          >
                            {l.app}
                          </button>
                        </td>
                        <td className="muted">
                          {l.topDevice}
                          {l.deviceCount > 1 ? ` +${l.deviceCount - 1} more` : ""}
                        </td>
                        <td>{formatBytes(l.bytes)}</td>
                        <td>
                          <div className="bar">
                            <span
                              style={{
                                width: `${Math.max(4, (l.bytes / (report.localServices[0]?.bytes || 1)) * 100)}%`,
                              }}
                            />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {report?.dailyFill?.totalBytes > 0 && (
              <div className="card">
                <h3>Device totals for missing days</h3>
                <p className="muted" style={{ marginTop: 0 }}>
                  From UniFi's daily per-device report, for days the app does not fully have:{" "}
                  {report.dailyFill.days.length} {report.dailyFill.days.length === 1 ? "day" : "days"},{" "}
                  {formatBytes(report.dailyFill.totalBytes)}. Internet traffic per device only — kept apart from the totals above.
                </p>
                <table>
                  <tbody>
                    {report.dailyFill.devices.slice(0, 10).map((d) => (
                      <tr key={d.mac}>
                        <td>{d.name}</td>
                        <td>{formatBytes(d.bytes)}</td>
                        <td>
                          <div className="bar">
                            <span style={{ width: `${Math.max(3, (d.bytes / (report.dailyFill.devices[0]?.bytes || 1)) * 100)}%` }} />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {(report?.siem?.configured || report?.siem?.eventCount > 0 || report?.siem?.adBlocks?.count > 0) && (
              <div className="card">
                <h3>Network events</h3>
                <p className="muted" style={{ marginTop: 0 }}>
                  From UniFi's System Log: when devices connected, disconnected and roamed, where, and what else UniFi
                  logged. The data use shown is per connection, reported when the device disconnected — it is not part of
                  the totals above.
                </p>
                {report.siem.adBlocks.count > 0 && (
                  <p style={{ margin: "0 0 10px" }}>
                    <strong>{report.siem.adBlocks.count.toLocaleString()} ads blocked</strong>
                    <span className="muted">
                      {" "}
                      · top: {report.siem.adBlocks.topDomains.slice(0, 4).map((d) => `${d.name} (${d.count})`).join(", ")}
                      {report.siem.adBlocks.topDevices.length
                        ? ` · most from ${report.siem.adBlocks.topDevices.slice(0, 3).map((d) => `${d.name} (${d.count})`).join(", ")}`
                        : ""}
                    </span>
                  </p>
                )}
                {report.siem.events.length ? (
                  <table>
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>Event</th>
                        {selected === "all" ? <th>Device</th> : null}
                        <th>Where</th>
                        <th>Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.siem.events.slice(0, 50).map((e, i) => (
                        <tr key={`${e.ts}-${i}`} title={e.msg || ""}>
                          <td>{e.at}</td>
                          <td>
                            {e.name}
                            {e.category ? <div className="muted">{e.category}</div> : null}
                          </td>
                          {selected === "all" ? <td className="muted">{e.device}</td> : null}
                          <td className="muted">{e.via || "—"}</td>
                          <td className="muted">
                            {[
                              e.duration ? `connected ${e.duration}` : null,
                              e.usageDown || e.usageUp ? `↓ ${e.usageDown || "0"} · ↑ ${e.usageUp || "0"}` : null,
                            ]
                              .filter(Boolean)
                              .join(" · ") || "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="muted">No events in this period yet.</p>
                )}
                {report.siem.eventCount > 50 && (
                  <p className="muted" style={{ marginBottom: 0 }}>
                    Showing the latest 50 of {report.siem.eventCount.toLocaleString()} events.
                  </p>
                )}
              </div>
            )}

            <div className="card">
              <h3>{focusedName ? `${focusedName} sessions` : "Activity"}</h3>
              <p className="muted" style={{ marginTop: 0 }}>
                Continuous use, in 5-minute steps (hourly for older days); a quiet gap over 10 minutes starts a new
                session. Below each app: the connections the device made at the time.
                {report?.sessionsOmitted?.count
                  ? ` ${report.sessionsOmitted.count} smaller bursts (${formatBytes(report.sessionsOmitted.bytes)}) are not listed.`
                  : ""}
              </p>
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>For</th>
                    <th>App</th>
                    {selected === "all" ? <th>Device</th> : null}
                    <th>Traffic</th>
                  </tr>
                </thead>
                <tbody>
                  {(report.sessions || []).slice(0, 60).map((s, i) => (
                    <tr
                      key={`${s.start}-${s.mac}-${i}`}
                      className="row-click"
                      onClick={() => {
                        const match = report.apps.find((a) => a.app.toLowerCase() === String(s.app).toLowerCase());
                        if (match) setAppId(String(match.appId));
                      }}
                    >
                      <td>
                        {s.at}
                        <div className="muted">to {s.endAt}</div>
                      </td>
                      <td>
                        {s.durationMs ? formatDuration(Math.round(s.durationMs / 1000)) : "—"}
                      </td>
                      <td>
                        {s.app}
                        {s.source === "domain" ? <div className="muted">named by domain</div> : null}
                        {s.source === "ip" ? (
                          <div className="muted" title="Borrowed from another flow the same day where UniFi resolved this address">
                            named by IP lookup
                          </div>
                        ) : null}
                        {s.source === "asn" ? <div className="muted" title="Owner of the address block, not necessarily the service">named by network owner</div> : null}
                        <div className="muted">{(s.domains || []).slice(0, 2).join(", ")}</div>
                      </td>
                      {selected === "all" ? <td className="muted">{s.device}</td> : null}
                      <td>
                        {formatBytes(s.bytes)}
                        {s.flowCount ? <div className="muted">{s.flowCount} flows</div> : null}
                      </td>
                    </tr>
                  ))}
                  {!(report.sessions || []).length && (
                    <tr>
                      <td colSpan={selected === "all" ? 5 : 4} className="muted">
                        {report?.totals?.bytes > 0
                          ? "No time detail for this traffic — see the note above the chart."
                          : "No traffic in this window."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
      </>
      )}
    </div>
      </div>
    </div>
  );
}
