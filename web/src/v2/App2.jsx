import { useEffect, useMemo, useState } from "react";
import SideNav from "../shared/SideNav.jsx";

const isDesktop = Boolean(typeof window !== "undefined" && window.unifiDesktop?.isDesktop);
import { useViewHistory } from "../shared/useViewHistory.js";
import { AccountSettings, SettingsSection, SettingsIcon } from "../shared/Setup.jsx";

// v2 leads with what actually happened rather than with totals: a time map of which
// device was doing what, and a chronological feed underneath. Totals are context, not
// the headline. It reads the same /api/report as v1 — no server change was needed,
// because the session data added in UU-C-018 already carries device, service, start,
// end, duration and bytes.

const PERIODS = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "7d", label: "7 days" },
  { id: "14d", label: "14 days" },
  { id: "30d", label: "30 days" },
  { id: "custom", label: "Pick a day" },
];

// Recognisable services keep a fixed hue so YouTube is always the same colour between
// sessions and between views; everything else is hashed into the same palette.
const BRAND_HUES = {
  youtube: 0,
  netflix: 355,
  "amazon video": 190,
  "disney+": 225,
  twitch: 270,
  spotify: 140,
  tiktok: 320,
  instagram: 330,
  facebook: 215,
  "itunes/app store": 205,
};

function hueFor(name) {
  const key = String(name || "").toLowerCase();
  if (BRAND_HUES[key] != null) return BRAND_HUES[key];
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) % 360;
  return h;
}

const colorFor = (name) => `hsl(${hueFor(name)} 62% 58%)`;
const softColorFor = (name) => `hsl(${hueFor(name)} 62% 58% / 0.22)`;

// A session is a run of traffic with gaps under ten minutes, so a phone pinging once a
// minute produces one unbroken five-hour "session" at 0.5 KB/s. Drawn at full strength
// those trickles swamp the map and look identical to real streaming. Encoding
// throughput as brightness keeps the data honest and makes the map readable: faint is
// background chatter, solid is something actually running.
function rateOf(session) {
  const seconds = Math.max(1, Number(session.durationMs || 0) / 1000);
  return Number(session.bytes || 0) / seconds;
}

function intensityOf(session) {
  const kbs = rateOf(session) / 1024;
  if (!Number.isFinite(kbs) || kbs <= 0) return 0.22;
  // log scale from 2 KB/s (barely there) to 2 MB/s (saturated)
  const t = (Math.log10(kbs) - Math.log10(2)) / (Math.log10(2048) - Math.log10(2));
  return Math.min(1, Math.max(0.22, 0.22 + t * 0.78));
}

const blockColorFor = (session) =>
  `hsl(${hueFor(session.app)} 62% 58% / ${intensityOf(session).toFixed(2)})`;

function formatRate(session) {
  const kbs = rateOf(session) / 1024;
  return kbs >= 1024 ? `${(kbs / 1024).toFixed(1)} MB/s` : `${kbs.toFixed(kbs >= 10 ? 0 : 1)} KB/s`;
}

function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i += 1;
  }
  return `${x.toFixed(x >= 10 ? 0 : 1)} ${units[i]}`;
}

function formatSpan(ms) {
  // Cached flows from before UU-C-040 have no end time. Show that as unknown rather
  // than "0s", which reads as a session that moved gigabytes in no time at all.
  if (!Number(ms)) return "—";
  const s = Math.max(0, Math.round(Number(ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

function formatAge(ts) {
  if (!ts) return "no data yet";
  const s = Math.max(0, Math.round((Date.now() - Number(ts)) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h === 1 ? "1 hour ago" : `${h} hours ago`;
}

async function api(path, opts) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  if (res.status === 401) {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
    throw new Error("login required");
  }
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}

export default function App2() {
  const [period, setPeriod] = useState("today");
  const [date, setDate] = useState("");
  const [mac, setMac] = useState("all");
  const [service, setService] = useState("all");
  const [report, setReport] = useState(null);
  const [clients, setClients] = useState([]);
  const [cacheInfo, setCacheInfo] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [focus, setFocus] = useState(null);
  const [navOpen, setNavOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState({ host: "", site: "default", apiKey: "" });
  const [hasApiKey, setHasApiKey] = useState(false);
  const { canGoBack, back } = useViewHistory({ period, date, mac, service }, (v) => {
    setPeriod(v.period);
    setDate(v.date);
    setMac(v.mac);
    setService(v.service);
  });
  const [trayMode, setTrayMode] = useState(false);

  useEffect(() => {
    api("/api/settings")
      .then((d) => setTrayMode(Boolean(d.trayMode)))
      .catch(() => {});
  }, []);

  async function openSettings() {
    setNavOpen(false);
    try {
      const d = await api("/api/settings");
      setHasApiKey(Boolean(d.hasApiKey));
      setSettings({ host: d.host || "", site: d.site || "default", apiKey: "", tz: d.tz || "" });
    } catch {
      setHasApiKey(false);
      setSettings({ host: "", site: "default", apiKey: "" });
    }
    setSettingsOpen(true);
  }

  async function saveSettings(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const payload = { ...settings, trayMode };
      if (!payload.apiKey) delete payload.apiKey;
      await api("/api/settings", { method: "PUT", body: JSON.stringify(payload) });
      setSettingsOpen(false);
      await loadReport();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function setBackground(enabled, hide) {
    setTrayMode(enabled);
    try {
      await api("/api/app/tray", { method: "POST", body: JSON.stringify({ enabled, hide: Boolean(hide) }) });
      window.unifiDesktop?.setTrayMode?.(enabled);
      if (hide) window.unifiDesktop?.hideToTray?.();
    } catch (err) {
      setError(err.message);
    }
  }

  async function quitApp() {
    if (window.unifiDesktop?.quit) {
      await window.unifiDesktop.quit();
      return;
    }
    try {
      await api("/api/shutdown", { method: "POST" });
    } catch {
      /* the host closes the window */
    }
  }

  const filtersActive = period !== "today" || mac !== "all" || service !== "all" || date !== "";

  function resetFilters() {
    setPeriod("today");
    setDate("");
    setMac("all");
    setService("all");
    setFocus(null);
  }

  async function loadReport() {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ period });
      if (mac !== "all") params.set("mac", mac);
      if (period === "custom" && date) params.set("date", date);
      setReport(await api(`/api/report?${params}`));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadReport().catch((err) => setError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, date, mac]);

  useEffect(() => {
    api("/api/clients?scope=known")
      .then((d) => setClients(d.clients || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let timer;
    let stopped = false;
    async function tick() {
      try {
        const d = await api("/api/cache");
        if (!stopped) setCacheInfo(d);
        timer = setTimeout(tick, d.warming ? 1500 : 15000);
      } catch {
        timer = setTimeout(tick, 5000);
      }
    }
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  async function refetchAll() {
    if (!window.confirm("Re-download the whole fetch window from UniFi? This can take a while.")) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/cache/refetch", { method: "POST", body: "{}" });
      await loadReport();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function backfillGaps() {
    const n = cacheInfo?.gaps?.length || 0;
    if (!n) return;
    if (!window.confirm(`Fetch ${n} missing day${n === 1 ? "" : "s"} from UniFi?`)) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/cache/backfill", { method: "POST", body: "{}" });
      await loadReport();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function fetchNew() {
    setBusy(true);
    setError("");
    try {
      await api("/api/cache/delta", { method: "POST", body: JSON.stringify({ period, date }) });
      await loadReport();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const allSessions = report?.sessions || [];
  const services = useMemo(() => {
    const byName = new Map();
    for (const s of allSessions) byName.set(s.app, (byName.get(s.app) || 0) + s.bytes);
    // Alphabetical for lookup, matching the classic view's App picker.
    return [...byName.entries()]
      .map(([name, bytes]) => ({ name, bytes }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }, [allSessions]);

  const sessions = useMemo(
    () => (service === "all" ? allSessions : allSessions.filter((s) => s.app === service)),
    [allSessions, service]
  );

  // Device lanes for the time map, busiest first. Capped so the map stays legible; the
  // feed below is never capped by device.
  const lanes = useMemo(() => {
    const byMac = new Map();
    for (const s of sessions) {
      const cur = byMac.get(s.mac) || { mac: s.mac, device: s.device, bytes: 0, items: [] };
      cur.bytes += s.bytes;
      cur.items.push(s);
      byMac.set(s.mac, cur);
    }
    return [...byMac.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 14);
  }, [sessions]);

  const range = useMemo(() => {
    const start = report?.start ?? 0;
    const end = report?.end ?? start + 1;
    return { start, end, span: Math.max(1, end - start) };
  }, [report]);

  // Ticks: hours for a single day, days for a multi-day range.
  const ticks = useMemo(() => {
    const out = [];
    const zone = report?.tz || undefined;
    const isDay = range.span <= 36 * 3600 * 1000;
    if (!isDay) {
      // Calendar days in the server tz — stepping 24h from range.start in UTC skipped
      // or duplicated labels across DST, and a missing Sep 15 label made an empty
      // column look like a missing day.
      const keyOf = (ms) =>
        new Intl.DateTimeFormat("en-CA", {
          timeZone: zone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date(ms));
      const labelOf = (ms) =>
        new Intl.DateTimeFormat("en-US", {
          timeZone: zone,
          month: "short",
          day: "numeric",
        }).format(new Date(ms));
      let t = range.start;
      let last = "";
      while (t < range.end) {
        const key = keyOf(t);
        if (key !== last) {
          out.push({ pct: ((t - range.start) / range.span) * 100, label: labelOf(t) });
          last = key;
        }
        t += 60 * 60 * 1000;
      }
      return out;
    }
    const step = 3 * 3600 * 1000;
    for (let t = range.start; t < range.end; t += step) {
      out.push({
        pct: ((t - range.start) / range.span) * 100,
        label: new Date(t).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZone: zone,
        }),
      });
    }
    return out;
  }, [range, report?.tz]);

  const totals = report?.totals || { bytes: 0 };
  // From the report's own totals, which are sorted by bytes. `services` is alphabetical
  // (it feeds the picker), so services[0] was simply the first name in the alphabet —
  // "Adobe.com" as the top service of a 951 GB week dominated by a download box. The lanes
  // come from the capped session list, so they are not a total either.
  const busiest =
    service === "all"
      ? report?.clients?.[0] && { device: report.clients[0].name || report.clients[0].mac }
      : lanes[0];
  const topService =
    service === "all" ? report?.apps?.[0] && { name: report.apps[0].app } : { name: service };

  return (
    <div className="v2-shell">
      <SideNav
        open={navOpen}
        onClose={() => setNavOpen(false)}
        view="timeline"
        classicHref="../index.html"
        timelineHref="./index.html"
        warming={Boolean(cacheInfo?.warming)}
        statusText={cacheInfo?.warming ? "Gathering data…" : `Cached ${formatAge(cacheInfo?.fetchedAt)}`}
        gaps={cacheInfo?.gaps?.length || 0}
        busy={busy || loading}
        onFetchNew={fetchNew}
        onBackfill={backfillGaps}
        onRefetchAll={refetchAll}
        onReload={() => loadReport()}
        onOpenSettings={openSettings}
        trayMode={trayMode}
        // Desktop-only: in the Docker web UI there is no tray, and "Exit" would stop the
        // container for everyone (the server refuses it in server mode anyway).
        onToggleTray={isDesktop ? (next) => setBackground(next, false) : undefined}
        onMinimize={isDesktop ? () => setBackground(true, true) : undefined}
        onQuit={isDesktop ? quitApp : undefined}
      />

      {settingsOpen && (
        <div className="v2-modal-back" onClick={() => setSettingsOpen(false)}>
          <form className="v2-modal settings-modal" onClick={(e) => e.stopPropagation()} onSubmit={saveSettings}>
            <div className="settings-head">
              <span className="set-icon">
                <SettingsIcon name="sliders" />
              </span>
              <h2>Settings</h2>
              <button type="button" className="settings-close" onClick={() => setSettingsOpen(false)} aria-label="Close">
                ×
              </button>
            </div>
            <div className="settings-body">
            <SettingsSection icon="console" title="UniFi console" hint="Where NetLens reads your network from, with a local API key.">
            <label>
              Console address
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
            </SettingsSection>
            <AccountSettings tz={settings.tz} onTz={(tz) => setSettings({ ...settings, tz })} />
            </div>
            <div className="v2-modal-actions settings-foot">
              <button type="button" className="v2-btn v2-ghost" onClick={() => setSettingsOpen(false)}>
                Cancel
              </button>
              <button type="submit" className="v2-btn" disabled={busy}>
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="v2-main">
      <header className="v2-top">
        <div className="v2-brand">
          <button className="v2-nav-toggle" onClick={() => setNavOpen((v) => !v)} aria-label="Menu">
            <span />
            <span />
            <span />
          </button>
          <h1>NetLens</h1>
          <span className="v2-pill">v2</span>
        </div>
        <div className="v2-top-actions">
          <button className="v2-btn v2-ghost" disabled={!canGoBack} onClick={back} title="Back (Alt+←)">
            ← Back
          </button>
          {cacheInfo?.gaps?.length > 0 && (
            <span className="v2-warn" title="Days the app was closed for">
              {cacheInfo.gaps.length} missing {cacheInfo.gaps.length === 1 ? "day" : "days"}
            </span>
          )}
        </div>
      </header>

      <div className="v2-filters">
        <div className="v2-chips">
          {PERIODS.map((p) => (
            <button
              key={p.id}
              className={`v2-chip ${period === p.id ? "on" : ""}`}
              onClick={() => setPeriod(p.id)}
            >
              {p.label}
            </button>
          ))}
          {period === "custom" && (
            <input
              className="v2-date"
              type="date"
              value={date}
              min={cacheInfo?.oldestRetainedKey}
              max={cacheInfo?.todayKey}
              onChange={(e) => setDate(e.target.value)}
            />
          )}
        </div>

        <div className="v2-selects">
          <select value={mac} onChange={(e) => setMac(e.target.value)}>
            <option value="all">Every device</option>
            {clients.map((c) => (
              <option key={c.mac} value={c.mac}>
                {c.name || c.mac}
              </option>
            ))}
          </select>
          <select value={service} onChange={(e) => setService(e.target.value)}>
            <option value="all">Every service</option>
            {services.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </select>
          <button className="v2-btn v2-ghost" onClick={resetFilters} disabled={!filtersActive}>
            Reset
          </button>
        </div>
      </div>

      {error && <div className="v2-error">{error}</div>}

      <section className="v2-summary">
        <div>
          <span className="v2-dim">Traffic</span>
          <strong>{formatBytes(totals.bytes)}</strong>
          {report?.localBytes > 0 && (
            // UniFi counts internet traffic only; LAN traffic is flow-derived and kept apart.
            <span className="v2-dim">+ {formatBytes(report.localBytes)} local</span>
          )}
        </div>
        <div>
          <span className="v2-dim">Sessions</span>
          <strong>
            {service === "all" && report?.sessionCount > sessions.length
              ? `${sessions.length} of ${report.sessionCount}`
              : sessions.length}
          </strong>
        </div>
        <div>
          <span className="v2-dim">Busiest device</span>
          <strong title={busiest?.device}>{busiest ? busiest.device : "—"}</strong>
        </div>
        <div>
          <span className="v2-dim">Top service</span>
          <strong style={topService ? { color: colorFor(topService.name) } : undefined}>
            {topService ? topService.name : "—"}
          </strong>
        </div>
      </section>

      <section className="v2-card">
        <div className="v2-card-head">
          <h2>When it happened</h2>
          <span className="v2-dim">
            {lanes.length
              ? "Colour is the service, brightness is how hard it was running. Click a block to filter."
              : ""}
          </span>
        </div>
        {(report?.lostSpans || []).length > 0 && (
          // Same rule as the classic view: deleted by UniFi before it was saved (UU-F-053).
          <p className="v2-lost">
            Missing: UniFi had already deleted{" "}
            {report.lostSpans
              .map((sp) => (sp.whole ? sp.at.split(",")[0] : `${sp.at.split(",")[0]} ${sp.at.split(", ")[1]}–${sp.endAt.split(", ")[1]}`))
              .join(", ")}{" "}
            before the app saved it. Lanes are blank there because the data is gone, not because nothing happened.
          </p>
        )}

        {loading && !report ? (
          <p className="v2-dim">Loading…</p>
        ) : !lanes.length ? (
          <p className="v2-dim">
            No sessions in this window. Try a longer period, or press Fetch new data.
          </p>
        ) : (
          <div className="v2-map">
            <div className="v2-axis">
              {ticks.map((t) => (
                <span key={t.pct} className="v2-tick" style={{ left: `${t.pct}%` }}>
                  {t.label}
                </span>
              ))}
            </div>

            {lanes.map((lane) => (
              <div className="v2-lane" key={lane.mac}>
                <button
                  className="v2-lane-name"
                  title={`${lane.device} · ${formatBytes(lane.bytes)}`}
                  onClick={() => setMac(mac === lane.mac ? "all" : lane.mac)}
                >
                  {lane.device}
                </button>
                <div className="v2-track">
                  {ticks.map((t) => (
                    <span key={`g${t.pct}`} className="v2-grid" style={{ left: `${t.pct}%` }} />
                  ))}
                  {lane.items.map((s, i) => {
                    const left = ((s.start - range.start) / range.span) * 100;
                    const width = Math.max(0.4, ((s.end - s.start) / range.span) * 100);
                    return (
                      <button
                        key={`${s.start}-${i}`}
                        className={`v2-block ${focus === s ? "focused" : ""}`}
                        style={{
                          left: `${left}%`,
                          width: `${width}%`,
                          background: blockColorFor(s),
                          boxShadow: `0 0 0 1px ${softColorFor(s.app)}`,
                        }}
                        onMouseEnter={() => setFocus(s)}
                        onFocus={() => setFocus(s)}
                        onClick={() => setService(service === s.app ? "all" : s.app)}
                        title={`${s.app} · ${s.at} → ${s.endAt} · ${formatBytes(s.bytes)} · ${formatRate(s)}`}
                      />
                    );
                  })}
                </div>
              </div>
            ))}

            <div className="v2-focus">
              {focus ? (
                <>
                  <span className="v2-swatch" style={{ background: colorFor(focus.app) }} />
                  <strong>{focus.app}</strong>
                  <span className="v2-dim">on</span>
                  <strong>{focus.device}</strong>
                  <span className="v2-dim">
                    {focus.at} → {focus.endAt} · {formatSpan(focus.durationMs)} · {formatBytes(focus.bytes)} ·{" "}
                    {formatRate(focus)}
                    {focus.flowCount ? ` · ${focus.flowCount} flows` : ""}
                    {focus.domains?.length ? ` · ${focus.domains.slice(0, 2).join(", ")}` : ""}
                  </span>
                </>
              ) : (
                <span className="v2-dim">Hover a block for detail.</span>
              )}
            </div>
          </div>
        )}
      </section>

      <section className="v2-card">
        <div className="v2-card-head">
          <h2>Session log</h2>
          <span className="v2-dim">{sessions.length} in view, newest first</span>
        </div>
        <div className="v2-feed">
          {sessions.slice(0, 80).map((s, i) => (
            <div className="v2-row" key={`${s.start}-${s.mac}-${i}`}>
              <div className="v2-when">
                <strong>{s.at}</strong>
                <span className="v2-dim">{formatSpan(s.durationMs)}</span>
              </div>
              <button
                className="v2-service"
                style={{ background: softColorFor(s.app), color: colorFor(s.app) }}
                onClick={() => setService(service === s.app ? "all" : s.app)}
              >
                {s.app}
              </button>
              <button className="v2-device" onClick={() => setMac(mac === s.mac ? "all" : s.mac)}>
                {s.device}
              </button>
              <div className="v2-domains v2-dim">
                {(s.domains || []).slice(0, 2).join(", ")}
                {s.source === "ip" ? " · named by IP lookup" : ""}
                {s.source === "asn" ? " · named by network owner" : ""}
              </div>
              <div className="v2-bytes">{formatBytes(s.bytes)}</div>
            </div>
          ))}
          {!sessions.length && <p className="v2-dim">Nothing to show for these filters.</p>}
        </div>
      </section>
      </div>
    </div>
  );
}
