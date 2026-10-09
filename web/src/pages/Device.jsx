import { useMemo, useState } from "react";

import { api, bytes, clock, duration, go, href, rate, speed, todayKey, useApi } from "../lib.js";
import { DayStep, Failed, Loading, Meter } from "../ui.jsx";

// One device (UU-C-087): its day — traffic, signal and events by hour — its connection,
// apps, sessions and events, and blocking. Everything links back to the hour or event.

const HOUR = 3600000;
const BAND = { ng: "2.4 GHz", na: "5 GHz", "6e": "6 GHz", "6 GHz": "6 GHz", "5 GHz": "5 GHz", "2.4 GHz": "2.4 GHz" };
const sigColor = (s) => (s == null ? "var(--cell-0)" : s < -80 ? "#b4513f" : s < -75 ? "#a8752a" : "#3a7d5c");

function csv(rows) {
  return rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
}

export default function Device({ route }) {
  const mac = String(route.arg || "").toLowerCase();
  const date = route.query.d || todayKey();
  const isToday = date === todayKey();
  const period = isToday ? "period=today" : `period=custom&date=${date}`;
  const report = useApi(`/api/report?${period}&mac=${encodeURIComponent(mac)}`);
  const wifi = useApi(`/api/wifi?${period}&mac=${encodeURIComponent(mac)}`);
  const day = useApi(`/api/day?date=${date}`);
  // Blocked state lives in UniFi's full client list (a blocked device is usually offline).
  const clients = useApi("/api/clients?scope=all");
  const [blockedNow, setBlocked] = useState(null);
  const blocked = blockedNow ?? Boolean(clients.data?.clients?.find((c) => String(c.mac).toLowerCase() === mac)?.blocked);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const row = day.data?.rows?.find((r) => r.mac === mac) || null;
  const r = report.data;
  const w = wifi.data;
  const name = row?.name || r?.clients?.[0]?.name || w?.name || mac;
  const link = row?.link || null;

  // Signal per hour from the 5-minute samples.
  const sigHours = useMemo(() => {
    const out = Array.from({ length: 24 }, () => []);
    if (!w?.series || !day.data) return out.map(() => null);
    for (const s of w.series) {
      const h = Math.floor((s.t - day.data.start) / HOUR);
      if (h >= 0 && h < 24 && s.signal != null) out[h].push(s.signal);
    }
    return out.map((l) => (l.length ? Math.round(l.reduce((a, b) => a + b, 0) / l.length) : null));
  }, [w, day.data]);

  const timeline = (r?.timeline || []).slice(0, 24);
  const tmax = Math.max(1, ...timeline.map((b) => b.totalBytes || 0));
  const appsMax = Math.max(1, ...(r?.apps || []).map((a) => a.totalBytes));
  const items = useMemo(() => {
    const list = [];
    for (const s of r?.sessions || []) list.push({ ts: s.start, at: `${clock(s.start)} – ${clock(s.end)}`, what: s.app, detail: (s.domains || []).join(", "), v: bytes(s.bytes), kind: "session" });
    for (const e of r?.siem?.events || []) list.push({ ts: e.ts, at: clock(e.ts), what: e.name, detail: [e.via, e.duration, e.usageDown && `↓ ${e.usageDown}`].filter(Boolean).join(" · "), v: "", kind: "event" });
    for (const x of w?.roams || []) if (!list.some((i) => i.kind === "event" && Math.abs(i.ts - x.ts) < 2000)) list.push({ ts: x.ts, at: clock(x.ts), what: "Roamed", detail: x.msg || x.via || "", v: "", kind: "event" });
    return list.sort((a, b) => b.ts - a.ts);
  }, [r, w]);

  async function toggleBlock() {
    const next = !blocked;
    if (!window.confirm(next ? `Block ${name}? It loses network access until you unblock it.` : `Unblock ${name}?`)) return;
    setBusy(true);
    setMsg("");
    try {
      const res = await api(`/api/clients/${encodeURIComponent(mac)}/block`, { method: "POST", body: JSON.stringify({ blocked: next }) });
      setBlocked(Boolean(res.blocked));
      setMsg(res.blocked ? "Blocked in UniFi." : "Unblocked in UniFi.");
    } catch (err) {
      setMsg(err.message);
    } finally {
      setBusy(false);
    }
  }

  function exportCsv() {
    const body = csv([["time", "type", "what", "detail", "data"], ...items.map((i) => [new Date(i.ts).toISOString(), i.kind, i.what, i.detail, i.v])]);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([body], { type: "text/csv" }));
    a.download = `netlens-${name.replace(/[^\w.-]+/g, "_")}-${date}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const loading = report.loading && !r;
  const err = report.error || wifi.error || day.error;
  const current = w?.current;
  const wired = link ? link.wired : w?.wired;
  const poorHours = sigHours.filter((s) => s != null && s < -80).length;
  return (
    <div className="page narrow">
      <div className="crumbs">
        <a href={href("home")}>Home</a>
        <span>/</span>
        <a href={href("day", null, { d: date })}>Day</a>
        <span>/</span>
        <span>{name}</span>
      </div>
      <div className="page-head">
        <div className="titles">
          {!wired && poorHours > 0 && <span className="tag warn">WEAK SIGNAL{isToday ? " TODAY" : ""}</span>}
          {wired && link?.speed != null && link.speed <= 100 && <span className="tag warn">SLOW LINK</span>}
          <h1 style={{ fontSize: 32 }}>{name}</h1>
          <span className="muted">
            {wired
              ? `Wired · ${link?.via || "switch"}${link?.port != null ? ` port ${link.port}` : ""}${link?.speed ? ` · ${speed(link.speed)}` : ""}`
              : current
                ? `Wi-Fi ${BAND[current.band] || current.band || ""} on ${current.ap}${current.essid ? ` · ${current.essid}` : ""}`
                : "Not seen on this day"}
            {link?.uptime != null ? ` · connected ${duration(link.uptime)}` : ""}
            {" · "}
            <span className="mono">{mac}</span>
          </span>
        </div>
        <DayStep date={date} onDate={(d) => go("device", mac, { d: d === todayKey() ? null : d })} />
        <button className="btn danger" onClick={toggleBlock} disabled={busy}>
          {blocked ? "Unblock" : "Block device"}
        </button>
      </div>
      {msg && <p className="note">{msg}</p>}
      {err && <Failed error={err} />}
      {loading && <Loading />}
      {r && (
        <>
          <div className="grid g4">
            <div className="card tight stat">
              <span className="label">{isToday ? "Today" : "That day"}</span>
              <span className="value">{bytes(r.totals.bytes)}</span>
              <span className="sub">↓ {bytes(r.totals.rx)} · ↑ {bytes(r.totals.tx)}</span>
            </div>
            {wired ? (
              <>
                <div className="card tight stat">
                  <span className="label">Link speed</span>
                  <span className={`value ${link?.speed <= 100 ? "warn" : ""}`}>{speed(link?.speed)}</span>
                  <span className="sub">{link?.via || "—"}{link?.port != null ? ` · port ${link.port}` : ""}</span>
                </div>
                <div className="card tight stat">
                  <span className="label">Connected</span>
                  <span className="value">{duration(link?.uptime)}</span>
                  <span className="sub">as UniFi counts it</span>
                </div>
              </>
            ) : (
              <>
                <div className="card tight stat">
                  <span className="label">Signal now</span>
                  <span className={`value ${current?.signal < -80 ? "bad" : current?.signal < -75 ? "warn" : ""}`}>{current?.signal ?? "—"} dBm</span>
                  <span className="sub">{current ? `at ${clock(current.ts)} · average ${w.summary.avgSignal ?? "—"}` : "no sample"}</span>
                </div>
                <div className="card tight stat">
                  <span className="label">Link</span>
                  <span className="value small">{current ? `Tx ${rate(current.txRate)} · Rx ${rate(current.rxRate)}` : "—"}</span>
                  <span className="sub">{current ? `ch ${current.channel}${current.width ? ` · ${current.width} MHz` : ""}` : ""}</span>
                </div>
              </>
            )}
            <div className="card tight stat">
              <span className="label">{wired ? "Apps" : "Roams"}</span>
              <span className="value">{wired ? r.apps.length : w?.roams?.length ?? 0}</span>
              <span className="sub">{wired ? "seen that day" : w?.favoriteAp ? `mostly on ${w.favoriteAp.ap}` : "from UniFi's log"}</span>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>Its day</h2>
              <span className="hint">by hour · click an hour to see it in 5-minute steps</span>
            </div>
            <div className="heat" style={{ gridTemplateColumns: "70px repeat(24, minmax(0, 1fr))" }}>
              <span className="dim small">Traffic</span>
              {Array.from({ length: 24 }, (_, h) => {
                const b = timeline[h];
                const later = !b || (isToday && b.t > Date.now());
                const nodata = b && !later && b.lost >= 0.99;
                return (
                  <button
                    key={h}
                    className={`cell ${later ? "later" : nodata ? "nodata" : ""}`}
                    style={later || nodata ? undefined : { background: b.totalBytes > 0 ? `color-mix(in srgb, var(--cell-4) ${Math.round(25 + 75 * Math.sqrt(b.totalBytes / tmax))}%, var(--cell-0))` : "var(--cell-0)" }}
                    title={b ? `${b.label} · ${bytes(b.totalBytes)}` : ""}
                    onClick={() => !later && !nodata && b && go("usage", null, { d: date, from: b.t, to: b.t + HOUR, mac })}
                  />
                );
              })}
              {!wired && <span className="dim small">Signal</span>}
              {!wired &&
                sigHours.map((s, h) => (
                  <span key={h} className="cell" style={{ background: s == null ? "var(--cell-0)" : sigColor(s), cursor: "default" }} title={s == null ? "no sample" : `${s} dBm`} />
                ))}
              <span className="dim small">Events</span>
              {Array.from({ length: 24 }, (_, h) => {
                const m = row?.marks?.[h];
                return (
                  <span key={h} className="small" style={{ textAlign: "center", color: m?.block ? "var(--bad)" : "#c8d2df" }}>
                    {m?.block ? "▲" : m?.roam || m?.conn ? "○".repeat(Math.min(2, (m.roam || 0) + (m.conn || 0))) : ""}
                  </span>
                );
              })}
              <span />
              {Array.from({ length: 24 }, (_, h) => (
                <span key={h} className="mono" style={{ textAlign: "center", fontSize: 10.5, color: "var(--faint)" }}>
                  {h % 3 === 0 ? String(h).padStart(2, "0") : ""}
                </span>
              ))}
            </div>
            <div className="legend">
              <span><i style={{ background: "var(--cell-4)" }} />traffic</span>
              {!wired && (
                <>
                  <span><i style={{ background: "#3a7d5c" }} />good signal</span>
                  <span><i style={{ background: "#a8752a" }} />weak (below −75)</span>
                  <span><i style={{ background: "#b4513f" }} />poor (below −80)</span>
                </>
              )}
              <span>○ roam / connect</span>
              <span><span className="bad">▲</span> blocked</span>
            </div>
            {w?.sampledSince > (day.data?.start || 0) && !wired && (
              <p className="dim small" style={{ margin: 0 }}>
                NetLens started sampling Wi-Fi {new Date(w.sampledSince).toLocaleString()}; signal before that is unknown. Roams come from UniFi's own log.
              </p>
            )}
          </div>

          <div className="grid g2">
            <div className="card">
              <div className="card-head">
                <h2>Apps</h2>
                <a className="end small" href={href("usage", null, { d: date, mac })}>Details</a>
              </div>
              {!r.apps.length && <span className="dim">No traffic counted.</span>}
              {r.apps.slice(0, 8).map((a) => (
                <a key={a.appId} href={href("usage", null, { d: date, mac, app: a.appId })} style={{ color: "var(--text)", display: "grid", gap: 4 }}>
                  <span style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                    <span className="ellipsis">{a.app} <span className="dim small">· {a.category}</span></span>
                    <span className="mono">{bytes(a.totalBytes)}</span>
                  </span>
                  <Meter share={a.totalBytes / appsMax} />
                </a>
              ))}
              {r.localBytes > 0 && (
                <p className="dim small" style={{ margin: 0 }}>
                  Plus {bytes(r.localBytes)} inside your own network ({r.localServices.slice(0, 3).map((s) => s.app).join(", ")}), which UniFi does not count.
                </p>
              )}
            </div>
            <div className="card">
              <div className="card-head">
                <h2>Sessions and events</h2>
                <button className="btn small end" onClick={exportCsv} disabled={!items.length}>Export CSV</button>
              </div>
              {!items.length && <span className="dim">Nothing recorded.</span>}
              <div className="rows">
                {items.slice(0, 60).map((i, n) => (
                  <div key={n} className="row" style={{ gridTemplateColumns: "104px minmax(0, 1fr) auto" }}>
                    <span className="mono small dim">{i.at}</span>
                    <span className="stack">
                      <span style={{ color: i.kind === "session" ? "var(--accent)" : "#c8d2df" }}>{i.what}</span>
                      <span className="dim small ellipsis">{i.detail}</span>
                    </span>
                    <span className="mono small">{i.v}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
