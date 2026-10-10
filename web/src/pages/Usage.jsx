import { bytes, clock, dayLabel, duration, go, href, isPlumbing, todayKey, useApi } from "../lib.js";
import { Bars, DayStep, Failed, Finder, Loading, Meter } from "../ui.jsx";

// Usage (UU-C-087): apps, categories, devices and sessions for a day, an hour or a range.
// Every figure on the page comes from one basis and adds up — header = apps = categories =
// devices = chart (+ what UniFi kept no time detail for). Filters are chips; click to drill.

const HOUR = 3600000;
const RANGES = [
  ["day", "Day"],
  ["7d", "7 days"],
  ["30d", "30 days"],
  ["90d", "90 days"],
];

export default function Usage({ route }) {
  const q = route.query;
  const range = q.r || "day";
  const date = q.d || todayKey();
  const isToday = date === todayKey();
  const params = new URLSearchParams();
  if (range === "day") {
    if (isToday && !q.from) params.set("period", "today");
    else {
      params.set("period", "custom");
      params.set("date", date);
    }
    if (q.from && q.to) {
      params.set("from", q.from);
      params.set("to", q.to);
    }
  } else params.set("period", range);
  if (q.mac) params.set("mac", q.mac);
  if (q.app) params.set("appId", q.app);
  if (q.cat) params.set("category", q.cat);
  const { data: r, error, loading, reload } = useApi(`/api/report?${params}`);
  const set = (patch) => go("usage", null, { ...q, ...patch });

  const device = q.mac ? r?.clients?.find((c) => c.mac === q.mac)?.name || q.mac : null;
  const appLabel = q.app ? (r?.apps?.find((a) => String(a.appId) === String(q.app))?.app || String(q.app).replace(/^svc:/, "")) : null;
  const catLabel = q.cat ? r?.categories?.find((c) => String(c.catId) === String(q.cat))?.category || "category" : null;
  const scope = q.from ? `${clock(Number(q.from))} – ${clock(Number(q.to))}` : range === "day" ? dayLabel(date) : `last ${range.replace("d", " days")}`;

  const chart = (r?.timeline || []).map((b) => ({
    value: b.totalBytes,
    nodata: b.lost >= 0.99,
    tip: `${b.label} · ${bytes(b.totalBytes)}${b.fillBytes ? ` (+${bytes(b.fillBytes)} daily total only)` : ""}`,
    onClick:
      r.grain === "day"
        ? () => go("usage", null, { ...q, r: null, d: b.label, from: null, to: null })
        : r.grain === "hour" && b.totalBytes > 0
          ? () => set({ from: b.t, to: b.t + HOUR })
          : undefined,
  }));
  // Finder groups and the top-apps row (UU-C-112). Plumbing (protocols, CDNs, unclassified)
  // stays pickable, last, under its own heading.
  const choices = r?.appChoices || [];
  const appItem = (a) => ({
    key: `a${a.value}`,
    label: a.app,
    sub: bytes(a.totalBytes),
    on: String(q.app) === String(a.value),
    pick: () => set({ app: a.value, cat: null }),
  });
  // UniFi's own app names only: a connection-record name (steamcontent.com) is often the same
  // traffic as an app already listed.
  const topApps = choices.filter((a) => a.source === "unifi" && !isPlumbing(a)).slice(0, 6);
  const finderGroups = [
    { label: "Apps", items: choices.filter((a) => a.source === "unifi" && !isPlumbing(a)).map(appItem) },
    { label: "Found in connection records", items: choices.filter((a) => a.source === "detected" && !isPlumbing(a)).map(appItem) },
    { label: "On your network", items: choices.filter((a) => a.source === "local").map(appItem) },
    {
      label: "Categories",
      items: (r?.categories || [])
        .filter((c) => c.catId != null)
        .map((c) => ({ key: `c${c.catId}`, label: c.category, sub: bytes(c.totalBytes), on: String(q.cat) === String(c.catId), pick: () => set({ cat: c.catId, app: null }) })),
    },
    {
      label: "Devices",
      items: (r?.clients || []).map((c) => ({ key: `d${c.mac}`, label: c.name || c.mac, sub: bytes(c.totalBytes), on: q.mac === c.mac, pick: () => set({ mac: c.mac }) })),
    },
    { label: "Protocols and background", items: choices.filter((a) => a.source !== "local" && isPlumbing(a)).map(appItem) },
  ];
  const busiest = (r?.apps || []).find((a) => !isPlumbing(a)) || r?.apps?.[0]; // a real app, not SSL/TLS
  const appsMax = Math.max(1, ...(r?.apps || []).map((a) => a.totalBytes));
  const catTotal = Math.max(1, (r?.categories || []).reduce((n, c) => n + c.totalBytes, 0));

  return (
    <div className="page">
      <div className="crumbs">
        <a href={href("home")}>Home</a>
        <span>/</span>
        <a href={href("usage", null, range === "day" ? { d: q.d } : { r: range })}>Usage</a>
        {q.from && (
          <>
            <span>/</span>
            <span>{scope}</span>
          </>
        )}
      </div>
      <div className="page-head">
        <div className="titles">
          <h1>{appLabel || device || "Usage"}{q.from ? ` · ${scope}` : ""}</h1>
          <span className="muted">
            {[device && appLabel ? device : null, range === "day" ? dayLabel(date) : `last ${range.replace("d", " days")}`].filter(Boolean).join(" · ")}
            {q.from ? " · every figure covers only this hour" : ""}
          </span>
        </div>
        <div className="seg" role="group" aria-label="Range">
          {RANGES.map(([id, label]) => (
            <button key={id} className={range === id ? "on" : ""} onClick={() => go("usage", null, { ...q, r: id === "day" ? null : id, from: null, to: null })}>
              {label}
            </button>
          ))}
        </div>
        {/* One box for apps, categories and devices (UU-C-112); replaces the app dropdown. */}
        {r && <Finder className="finder" browse placeholder="Filter by app, category or device" groups={finderGroups} />}
        {range === "day" && <DayStep date={date} onDate={(d) => set({ d: d === todayKey() ? null : d, from: null, to: null })} />}
      </div>

      {topApps.length > 0 && (
        <div className="quick" role="group" aria-label="Top apps">
          <span className="dim small">Top apps</span>
          {topApps.map((a) => (
            <button key={a.value} className={`btn small ${String(q.app) === String(a.value) ? "on" : ""}`} onClick={() => set({ app: String(q.app) === String(a.value) ? null : a.value, cat: null })}>
              {a.app.replace(/ \(.*\)$/, "")} <span className="dim">{bytes(a.totalBytes)}</span>
            </button>
          ))}
        </div>
      )}

      {(q.from || q.mac || q.app || q.cat) && (
        <div className="chips">
          {q.from && <span className="chip">{scope}<button aria-label="Remove hour filter" onClick={() => set({ from: null, to: null })}>×</button></span>}
          {q.mac && <span className="chip">Device: {device}<button aria-label="Remove device filter" onClick={() => set({ mac: null })}>×</button></span>}
          {q.app && <span className="chip">App: {appLabel}<button aria-label="Remove app filter" onClick={() => set({ app: null })}>×</button></span>}
          {q.cat && <span className="chip">Category: {catLabel}<button aria-label="Remove category filter" onClick={() => set({ cat: null })}>×</button></span>}
          {q.mac && <a className="btn small" href={href("device", q.mac, { d: q.d })}>Open device</a>}
          {(q.mac || q.app || q.cat) && (
            <a className="btn small" href={href("alerts", null, { mac: q.mac, macLabel: device, app: q.app, appLabel: appLabel, cat: q.cat, catLabel: catLabel })}>
              Alert me…
            </a>
          )}
        </div>
      )}

      {error && <Failed error={error} reload={reload} />}
      {!r && loading && <Loading />}
      {r && (
        <>
          <div className="grid g4">
            <div className="card tight stat">
              <span className="label">Total</span>
              <span className="value">{bytes(r.totals.bytes)}</span>
              <span className="sub">↓ {bytes(r.totals.rx)} · ↑ {bytes(r.totals.tx)}</span>
            </div>
            {/* Filtered to a device or an app: how long it was in use (UU-C-108). The busiest
                device / app cards drop out when the filter already names it. */}
            {(q.mac || q.app) && r.time && (
              <div className="card tight stat">
                <span className="label">Time in use</span>
                <span className="value">{r.time.inUseMs ? duration(r.time.inUseMs / 1000) : "—"}</span>
                <span className="sub">{r.time.sessions} session{r.time.sessions === 1 ? "" : "s"}, overlaps counted once</span>
              </div>
            )}
            {!q.mac && (
              <div className="card tight stat">
                <span className="label">Busiest device</span>
                <span className="value small ellipsis">{r.clients[0]?.name || "—"}</span>
                <span className="sub">{bytes(r.clients[0]?.totalBytes)}</span>
              </div>
            )}
            {!q.app && (
              <div className="card tight stat">
                <span className="label">Busiest app</span>
                <span className="value small ellipsis">{busiest?.app || "—"}</span>
                <span className="sub">{busiest ? `${bytes(busiest.totalBytes)} · ${busiest.category}` : ""}</span>
              </div>
            )}
            <div className="card tight stat">
              <span className="label">Inside your network</span>
              <span className="value">{bytes(r.localBytes)}</span>
              <span className="sub">not counted by UniFi</span>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>{r.grain === "5min" ? "In 5-minute steps" : r.grain === "hour" ? "By hour" : "By day"}</h2>
              <span className="hint">{r.grain === "hour" ? "click an hour to zoom in" : r.grain === "day" ? "click a day to open it" : ""}</span>
              {q.from && <button className="btn small end" onClick={() => set({ from: null, to: null })}>← Whole day</button>}
            </div>
            <Bars items={chart} />
            <div className="axis">
              <span>{r.timeline[0]?.label}</span>
              <span>{r.timeline[Math.floor(r.timeline.length / 2)]?.label}</span>
              <span>{r.timeline[r.timeline.length - 1]?.label}</span>
            </div>
            {r.basis === "flows" && <p className="note">UniFi doesn't identify this service, so everything here comes from its connection records.</p>}
            {r.unplacedBytes > 0.002 * (r.totals.bytes || 1) && (
              <p className="dim small" style={{ margin: 0 }}>
                {bytes(r.unplacedBytes)} of the {bytes(r.totals.bytes)} isn't drawn: it is counted, but UniFi {r.grain === "5min" ? "only kept an hourly total for it" : "no longer had hourly detail when it was saved"}.
              </p>
            )}
            {r.lostSpans?.length > 0 && <p className="note warn">Some of this time was never saved — UniFi had already deleted the detail. It is hatched, not empty.{r.dailyFill?.totalBytes > 0 ? ` UniFi's daily report still has ${bytes(r.dailyFill.totalBytes)} for those days (device totals only).` : ""}</p>}
          </div>

          <div className="grid g3">
            <div className="card span2">
              <div className="card-head"><h2>Apps</h2><span className="hint">click one to filter</span></div>
              <div className="scroll-x">
                <table className="t">
                  <thead><tr><th>App</th><th>Category</th><th>Top devices</th><th className="num">Traffic</th></tr></thead>
                  <tbody>
                    {r.apps.slice(0, 40).map((a) => (
                      <tr key={a.appId} className="click" onClick={() => set({ app: String(a.appId) === String(q.app) ? null : a.appId })}>
                        <td><strong style={{ fontWeight: 500 }}>{a.app}</strong><Meter share={a.totalBytes / appsMax} /></td>
                        <td className="muted">{a.category}</td>
                        <td className="muted small">{(a.topDevices || []).map((d) => d.name).join(", ")}</td>
                        <td className="num">{bytes(a.totalBytes)}</td>
                      </tr>
                    ))}
                    {!r.apps.length && <tr><td colSpan={4} className="dim">No traffic counted.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="card">
              <div className="card-head"><h2>Categories</h2></div>
              {r.categories.slice(0, 10).map((c) => (
                <button
                  key={c.catId ?? c.category}
                  className="row"
                  style={{ gridTemplateColumns: "minmax(0, 1fr) auto", borderRadius: 10, border: String(q.cat) === String(c.catId) ? "1px solid #2c4d7a" : undefined }}
                  onClick={() => c.catId != null && set({ cat: String(q.cat) === String(c.catId) ? null : c.catId, app: null })}
                >
                  <span className="stack"><span className="ellipsis">{c.category}</span><Meter share={c.totalBytes / catTotal} color="var(--ok)" /></span>
                  <span className="mono small">{bytes(c.totalBytes)}</span>
                </button>
              ))}
              {r.localServices?.length > 0 && (
                <>
                  <h2 style={{ marginTop: 6 }}>Inside your network</h2>
                  {r.localServices.slice(0, 6).map((s) => (
                    <button key={s.value} className="row" style={{ gridTemplateColumns: "minmax(0, 1fr) auto" }} onClick={() => set({ app: s.value })}>
                      <span className="stack"><span className="ellipsis">{s.app}</span><span className="dim small">{s.topDevice}</span></span>
                      <span className="mono small">{bytes(s.bytes)}</span>
                    </button>
                  ))}
                </>
              )}
            </div>
          </div>

          <div className="grid g2">
            {!q.mac && (
              <div className="card">
                <div className="card-head"><h2>Devices</h2><span className="hint">click to filter</span></div>
                {r.clients.slice(0, 15).map((c) => (
                  <button key={c.mac} className="row" style={{ gridTemplateColumns: "minmax(0, 1fr) auto" }} onClick={() => set({ mac: c.mac })}>
                    <span className="stack"><span className="ellipsis">{c.name}</span><Meter share={c.totalBytes / Math.max(1, r.clients[0]?.totalBytes || 1)} /></span>
                    <span className="mono small">{bytes(c.totalBytes)}</span>
                  </button>
                ))}
              </div>
            )}
            <div className={`card ${q.mac ? "span2" : ""}`} style={q.mac ? { gridColumn: "1 / -1" } : undefined}>
              <div className="card-head"><h2>Sessions</h2><span className="hint">{r.sessionCount} over 1 MB</span></div>
              <div className="rows">
                {r.sessions.slice(0, 40).map((s, i) => (
                  <div key={i} className="row" style={{ gridTemplateColumns: "120px minmax(0, 1fr) 90px" }}>
                    <span className="mono small dim">{s.at.split(", ").pop()} – {s.endAt.split(", ").pop()}</span>
                    <span className="stack">
                      <span>{s.app} <span className="dim">on</span> <a href={href("device", s.mac, { d: q.d })}>{s.device}</a></span>
                      <span className="dim small ellipsis">{(s.domains || []).join(", ")}</span>
                    </span>
                    <span className="mono small" style={{ textAlign: "right" }}>{bytes(s.bytes)}</span>
                  </div>
                ))}
                {r.sessionsOmitted?.count > 0 && (
                  <div className="row dim small" style={{ gridTemplateColumns: "1fr auto" }}>
                    <span>{r.sessionsOmitted.count} smaller sessions and background traffic</span>
                    <span className="mono">{bytes(r.sessionsOmitted.bytes)}</span>
                  </div>
                )}
                {!r.sessions.length && !r.sessionsOmitted?.count && <div className="dim">No sessions.</div>}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
