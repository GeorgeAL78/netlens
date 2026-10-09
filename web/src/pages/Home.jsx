import { useState } from "react";
import { bytes, clock, go, href, todayKey, useApi } from "../lib.js";
import { Bars, DayStep, Failed, Loading, levelColor } from "../ui.jsx";

// Home — the feed (UU-C-087): what happened today, in plain language, each finding linking
// to the place that shows it in full.

const FILTERS = [
  ["all", "Everything"],
  ["look", "Needs a look"],
  ["usage", "Usage"],
  ["link", "Wi-Fi & wired"],
  ["security", "Security"],
  ["equipment", "Equipment"],
];
const TAG = { usage: "USAGE", wifi: "WI-FI", wired: "WIRED", security: "SECURITY", device: "NEW DEVICE", equipment: "EQUIPMENT", data: "DATA" };

function actionsFor(f, date) {
  const a = [];
  if (f.span) a.push({ label: `See ${clock(f.span.from)} – ${clock(f.span.to)}`, to: href("usage", null, { d: date, from: f.span.from, to: f.span.to }) });
  if (f.mac) a.push({ label: f.kind === "wifi" ? "Signal history" : "Open device", to: href("device", f.mac, { d: date }) });
  if (f.uid) a.push({ label: "Event details", to: href("security", null, { e: f.uid }) });
  if (f.rule) a.push({ label: "Firewall events", to: href("security", null, { rule: f.rule }) });
  if (f.ip) a.push({ label: "Investigate address", to: href("security", null, { ip: f.ip }) });
  if (f.device) a.push({ label: "Open in network map", to: href("network", null, { n: f.device }) });
  if (f.kind === "data") a.push({ label: "Data settings", to: href("settings", null, { s: "data" }) });
  return a;
}

export default function Home({ route }) {
  const date = route.query.d || todayKey();
  const [filter, setFilter] = useState("all");
  const { data, error, loading, reload } = useApi(`/api/findings?date=${date}`, date === todayKey() ? 5 * 60 * 1000 : 0);
  const list = (data?.findings || []).filter((f) => {
    if (filter === "all") return true;
    if (filter === "look") return f.level !== "info";
    if (filter === "link") return f.kind === "wifi" || f.kind === "wired" || f.kind === "device";
    return f.kind === filter;
  });
  const look = (data?.findings || []).filter((f) => f.level !== "info").length;
  const now = data?.now;
  return (
    <div className="page">
      <div className="page-head">
        <div className="titles">
          <span className="dim small">{data?.today ? "So far today" : "On this day"}</span>
          <h1>{data?.today ? "Today on your network" : "That day on your network"}</h1>
        </div>
        <DayStep date={date} onDate={(d) => go("home", null, { d: d === todayKey() ? null : d })} />
      </div>
      {error && <Failed error={error} reload={reload} />}
      {!data && loading && <Loading />}
      {data && (
        <div className="split" style={{ gap: 28 }}>
          <div className="main" style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 820 }}>
            <div className="seg" role="group" aria-label="Show">
              {FILTERS.map(([id, label]) => (
                <button key={id} className={filter === id ? "on" : ""} onClick={() => setFilter(id)}>
                  {label}
                  {id === "look" && look ? ` · ${look}` : ""}
                </button>
              ))}
            </div>
            {!list.length && <div className="card empty">Nothing to report{filter !== "all" ? " here" : ""} — a quiet {data.today ? "day so far" : "day"}.</div>}
            {list.map((f) => (
              <article key={f.id} className={`finding lv-${f.level}`}>
                <div className="meta">
                  <span className="tag" style={{ color: levelColor[f.level] }}>
                    {f.level === "info" ? TAG[f.kind] || "NOTE" : "NEEDS A LOOK"}
                  </span>
                  <span>·</span>
                  <span>{f.level === "info" ? "" : `${TAG[f.kind] || ""} · `}{clock(f.ts)}</span>
                </div>
                <h3>{f.title}</h3>
                {f.text && <p>{f.text}</p>}
                {f.hourly && (
                  <Bars
                    short
                    items={f.hourly.map((v, i) => ({
                      value: v,
                      tip: `${String(i).padStart(2, "0")}:00 · ${bytes(v)}`,
                      color: f.span && new Date(f.span.from).getHours() === i ? "var(--cell-5)" : "var(--cell-2)",
                    }))}
                  />
                )}
                <div className="chips">
                  {actionsFor(f, date).map((a) => (
                    <a key={a.label} className="btn small" href={a.to}>
                      {a.label}
                    </a>
                  ))}
                </div>
              </article>
            ))}
          </div>
          <aside style={{ flex: "1 1 260px", maxWidth: 320, display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="card">
              <span className="dim small">{data.today ? "Right now" : "That day"}</span>
              <div className="kv">
                {now?.internet && (
                  <div>
                    <span>Internet</span>
                    <span className={now.internet.status === "ok" ? "ok" : "warn"}>
                      {now.internet.status === "ok" ? "OK" : now.internet.status || "unknown"}
                      {now.internet.latency != null ? ` · ${now.internet.latency} ms` : ""}
                    </span>
                  </div>
                )}
                {data.today && (
                  <div>
                    <span>Devices online</span>
                    <span className="mono">
                      {now.online.total} <span className="dim">({now.online.total - now.online.wired} Wi-Fi · {now.online.wired} wired)</span>
                    </span>
                  </div>
                )}
                <div>
                  <span>Traffic</span>
                  <span className="mono">{bytes(now.trafficBytes)}</span>
                </div>
                <div>
                  <span>Blocked</span>
                  <a href={href("security")} className={now.blocked ? "bad mono" : "mono"}>
                    {now.blocked}
                  </a>
                </div>
              </div>
            </div>
            <div className="card">
              <span className="dim small">Jump to</span>
              <a href={href("day", null, { d: date })}>Every device that day</a>
              <a href={href("usage", null, { d: date })}>Apps and categories</a>
              <a href={href("network")}>Network map</a>
              <a href={href("security")}>Security events</a>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
