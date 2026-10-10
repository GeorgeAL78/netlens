import { useState } from "react";
import { api, bytes, deviceGroups, duration, go, href, isPlumbing, useApi } from "../lib.js";
import { Failed, Finder, Loading, Meter } from "../ui.jsx";

// Alerts (UU-C-114): a daily limit on time in use or data, for one app or category on one
// device (or every device). NetLens checks every 5 minutes and flags a rule once a day when
// today's figure passes it — on this page, the Home feed and the tab's count. Watching only:
// nothing is blocked.

// Minutes or bytes; whole hours read "2h", not "2h 0m".
const amount = (metric, v) => (metric === "time" ? (v >= 60 && v % 60 === 0 ? `${v / 60}h` : duration(v * 60)) : bytes(v));

function Pick({ label, value, onClear, finder }) {
  return (
    <div className="stack" style={{ gap: 6 }}>
      <span className="dim small">{label}</span>
      {value ? (
        <span className="chip">
          {value}
          <button aria-label={`Clear ${label.toLowerCase()}`} onClick={onClear}>×</button>
        </span>
      ) : (
        finder
      )}
    </div>
  );
}

export default function Alerts({ route }) {
  const q = route.query;
  const alerts = useApi("/api/alerts");
  // UniFi's own client list (UU-C-118): a device forgotten in UniFi drops out here too.
  const clients = useApi("/api/devices");
  const week = useApi("/api/report?period=7d");
  const [device, setDevice] = useState(q.mac ? { mac: q.mac, label: q.macLabel || q.mac } : null);
  const [target, setTarget] = useState(q.app ? { app: q.app, label: q.appLabel || q.app } : q.cat ? { cat: q.cat, label: q.catLabel || "category" } : null);
  const [metric, setMetric] = useState("time");
  const [amountIn, setAmountIn] = useState("2");
  const [unit, setUnit] = useState("h");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const choices = week.data?.appChoices || [];
  const appItem = (a) => ({ key: `a${a.value}`, label: a.app, sub: bytes(a.totalBytes), pick: () => setTarget({ app: a.value, label: a.app }) });
  const targetGroups = [
    { label: "Apps", items: choices.filter((a) => a.source === "unifi" && !isPlumbing(a)).map(appItem) },
    { label: "Found in connection records", items: choices.filter((a) => a.source === "detected" && !isPlumbing(a)).map(appItem) },
    { label: "On your network", items: choices.filter((a) => a.source === "local").map(appItem) },
    {
      label: "Categories",
      items: (week.data?.categories || []).filter((c) => c.catId != null).map((c) => ({ key: `c${c.catId}`, label: c.category, sub: "category", pick: () => setTarget({ cat: c.catId, label: c.category }) })),
    },
    { label: "Protocols and background", items: choices.filter((a) => a.source !== "local" && isPlumbing(a)).map(appItem) },
  ];
  const devicePick = deviceGroups(clients.data?.devices, (c) => setDevice({ mac: c.mac, label: c.name || c.hostname || c.mac }));

  const limitValue = () => {
    const n = Number(String(amountIn).replace(",", "."));
    if (!(n > 0)) return null;
    if (metric === "time") return Math.round(unit === "h" ? n * 60 : n);
    return Math.round(unit === "GB" ? n * 1e9 : n * 1e6);
  };

  async function add() {
    const limit = limitValue();
    if (!limit) return setMsg("Enter a limit above zero.");
    setBusy(true);
    setMsg("");
    try {
      await api("/api/alerts", {
        method: "POST",
        body: JSON.stringify({
          mac: device?.mac,
          macLabel: device?.label,
          app: target?.app,
          appLabel: target?.app ? target.label : null,
          cat: target?.cat,
          catLabel: target?.cat ? target.label : null,
          metric,
          limit,
        }),
      });
      setTarget(null);
      setDevice(null);
      if (q.mac || q.app || q.cat) go("alerts");
      alerts.reload();
    } catch (err) {
      setMsg(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(rule) {
    await api(`/api/alerts/${rule.id}`, { method: "POST", body: JSON.stringify({ enabled: !rule.enabled }) }).catch(() => {});
    alerts.reload();
  }

  async function remove(rule) {
    if (!window.confirm(`Delete the alert “${rule.label}”?`)) return;
    await api(`/api/alerts/${rule.id}`, { method: "DELETE" }).catch(() => {});
    alerts.reload();
  }

  const rules = alerts.data?.rules || [];
  const events = alerts.data?.events || [];
  return (
    <div className="page">
      <div className="page-head">
        <div className="titles">
          <span className="dim small">Alerts</span>
          <h1>Daily limits</h1>
          <span className="muted">NetLens checks every 5 minutes and flags a rule once a day when it passes. It only watches — nothing is blocked.</span>
        </div>
      </div>

      <div className="card">
        <h2 style={{ fontSize: 16 }}>New alert</h2>
        <div className="grid g3" style={{ alignItems: "start" }}>
          <Pick
            label="Device"
            value={device?.label}
            onClear={() => setDevice(null)}
            finder={<Finder className="finder" browse placeholder="Any device — or pick one" groups={devicePick} />}
          />
          <Pick
            label="App or category"
            value={target?.label}
            onClear={() => setTarget(null)}
            finder={<Finder className="finder" browse placeholder="All traffic — or pick an app" groups={targetGroups} />}
          />
          <div className="stack" style={{ gap: 6 }}>
            <span className="dim small">Limit per day</span>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <div className="seg" role="group" aria-label="Limit on">
                <button className={metric === "time" ? "on" : ""} onClick={() => (setMetric("time"), setUnit("h"), setAmountIn("2"))}>Time</button>
                <button className={metric === "bytes" ? "on" : ""} onClick={() => (setMetric("bytes"), setUnit("GB"), setAmountIn("5"))}>Data</button>
              </div>
              <input className="field" style={{ width: 80 }} inputMode="decimal" aria-label="Limit" value={amountIn} onChange={(e) => setAmountIn(e.target.value)} />
              <select className="field" aria-label="Unit" value={unit} onChange={(e) => setUnit(e.target.value)}>
                {(metric === "time" ? ["h", "min"] : ["GB", "MB"]).map((u) => (
                  <option key={u} value={u}>{u === "h" ? "hours" : u === "min" ? "minutes" : u}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <button className="btn primary" disabled={busy} onClick={add}>Add alert</button>
          <span className="muted small">
            {target?.label || "All traffic"} on {device?.label || "any device"}, over {limitValue() ? amount(metric, limitValue()) : "—"}
            {metric === "time" ? " of use" : ""} in a day
          </span>
          {msg && <span className="bad small" role="alert">{msg}</span>}
        </div>
      </div>

      {alerts.error && <Failed error={alerts.error} reload={alerts.reload} />}
      {!alerts.data && alerts.loading && <Loading />}
      {alerts.data && (
        <div className="card" style={{ padding: "6px 10px" }}>
          <div className="rows">
            {!rules.length && <div className="empty">No alerts yet. Add one above, or use “Alert me” on a Usage screen.</div>}
            {rules.map((r) => {
              const share = Math.min(1, r.today.value / r.limit);
              return (
                <div key={r.id} className="row" style={{ gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr) auto", cursor: "default", opacity: r.enabled ? 1 : 0.55 }}>
                  <span className="stack">
                    <span className="ellipsis">
                      <a href={href("usage", null, { mac: r.mac, app: r.app, cat: r.cat })}>{r.label}</a>
                    </span>
                    <span className="dim small">over {amount(r.metric, r.limit)}{r.metric === "time" ? " of use" : ""} a day{r.enabled ? "" : " · paused"}</span>
                  </span>
                  <span className="stack">
                    <Meter share={share} color={r.today.over ? "var(--warn)" : undefined} />
                    <span className={`small ${r.today.over ? "warn" : "dim"}`}>
                      {amount(r.metric, r.today.value)} today{r.today.over ? " — passed" : ""}
                    </span>
                  </span>
                  <span style={{ display: "flex", gap: 6 }}>
                    <button className="btn small" onClick={() => toggle(r)}>{r.enabled ? "Pause" : "Resume"}</button>
                    <button className="btn small" onClick={() => remove(r)}>Delete</button>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {events.length > 0 && (
        <div className="card">
          <h2 style={{ fontSize: 16 }}>Last 30 days</h2>
          <div className="rows">
            {events.map((e) => (
              <div key={`${e.ruleId}-${e.day}`} className="row" style={{ gridTemplateColumns: "110px minmax(0, 1fr) auto", cursor: "default" }}>
                <span className="mono small dim">{e.day}</span>
                <span className="ellipsis">{e.label}</span>
                <span className="mono small">{e.metric ? amount(e.metric, e.value) : e.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
