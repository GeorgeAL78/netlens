import { useEffect, useState } from "react";
import { clock, href } from "./lib.js";

// Live traffic (UU-C-256, UU-C-258): one event stream from /api/live while the page is visible.
// The server reads UniFi every few seconds only while someone watches; a hidden tab closes the
// stream. History: the line's last hour from NetLens's 5-minute records ("coarse"), then the
// live readings, and per device and port the last 15 minutes.

export const LIVE_KEEP_MS = 15 * 60 * 1000;
export const bpsText = (bps) => (bps == null ? "—" : bps >= 1e9 ? `${(bps / 1e9).toFixed(2)} Gbps` : bps >= 1e6 ? `${(bps / 1e6).toFixed(bps >= 1e8 ? 0 : 1)} Mbps` : `${Math.round(bps / 1e3)} kbps`);

const trim = (pts, now) => pts.filter((p) => p[0] >= now - LIVE_KEEP_MS);

export function useLive() {
  const [state, setState] = useState({ points: [], coarse: [], devices: {}, ports: {}, latest: null, error: null, connected: false, tickMs: 2500 });
  useEffect(() => {
    let es = null;
    const open = () => {
      if (es) return;
      es = new EventSource("/api/live");
      es.addEventListener("history", (e) => {
        const h = JSON.parse(e.data);
        setState({ points: h.points || [], coarse: h.coarse || [], devices: h.devices || {}, ports: h.ports || {}, latest: h.latest, error: h.error, connected: true, tickMs: h.tickMs || 2500 });
      });
      es.onmessage = (e) => {
        const f = JSON.parse(e.data);
        setState((s) => {
          if (f.error) return { ...s, error: f.error };
          const now = f.ts;
          const points = [...s.points, { ts: now, down: f.down, up: f.up }].filter((p) => p.ts >= now - LIVE_KEEP_MS);
          const devices = { ...s.devices };
          for (const d of f.devices || []) {
            const prev = devices[d.mac];
            devices[d.mac] = { name: d.name, via: d.via, port: d.port ?? null, wired: d.wired, pts: trim([...(prev?.pts || []), [now, d.down, d.up]], now) };
          }
          const ports = { ...s.ports };
          for (const g of f.ports || []) {
            for (const p of g.ports) {
              const k = `${g.mac}|${p.idx}`;
              const prev = ports[k];
              ports[k] = { device: g.device, mac: g.mac, idx: p.idx, on: p.on, speed: p.speed, wan: Boolean(p.wan), pts: trim([...(prev?.pts || []), [now, p.toDevice, p.fromDevice]], now) };
            }
          }
          for (const m of [devices, ports]) for (const k of Object.keys(m)) if (!m[k].pts.length) delete m[k];
          return { ...s, points, devices, ports, latest: f, error: null, connected: true };
        });
      };
      es.onerror = () => setState((s) => ({ ...s, connected: false }));
    };
    const close = () => {
      es?.close();
      es = null;
    };
    const onVis = () => (document.visibilityState === "visible" ? open() : close());
    open();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      close();
    };
  }, []);
  return state;
}

// A port's reading from your side: the internet port ↓ download (from the ISP), ↑ upload.
export const portDir = (p, to, from) => (p.wan ? { down: from, up: to } : { down: to, up: from });

// The main graph: the last `windowMs` (default an hour). NetLens's 5-minute records fill the
// part before the live readings (dimmer); `overlay` is one device's or port's live line.
export function LiveChart({ points, coarse = [], overlay = null, windowMs = 60 * 60e3, height = 170, linkMbps, axis = true }) {
  const W = 900;
  const H = height;
  const now = points.length ? points[points.length - 1].ts : Date.now();
  const liveFrom = points.length ? points[0].ts : now;
  const old = coarse.filter((p) => p.ts >= now - windowMs && p.ts < liveFrom);
  const vals = [...old, ...points].flatMap((p) => [p.down, p.up]).concat(overlay ? overlay.pts.flatMap((p) => [p.down, p.up]) : []);
  const top = Math.max(10e6, ...vals) * 1.15;
  const x = (ts) => W - ((now - ts) / windowMs) * W;
  const y = (v) => H - (v / top) * H;
  const line = (list, key) => list.map((p) => `${x(p.ts).toFixed(1)},${y(p[key]).toFixed(1)}`).join(" ");
  const area = (list) => (list.length ? `${x(list[0].ts).toFixed(1)},${H} ${line(list, "down")} ${x(list[list.length - 1].ts).toFixed(1)},${H}` : "");
  // Axes (UU-C-260): grid lines at round rates (1, 2 or 5 × 10^n bits/s), labelled on the left;
  // clock times along the bottom every 10 minutes (every 2 on a short window).
  const nice = (v) => {
    const p = 10 ** Math.floor(Math.log10(v));
    return [1, 2, 5, 10].map((m) => m * p).find((m) => m >= v);
  };
  const stepV = nice(top / 4);
  const grid = [];
  for (let g = stepV; g < top; g += stepV) grid.push(g);
  const mins = Math.round(windowMs / 60e3);
  const tickMs = (windowMs > 20 * 60e3 ? 10 : 2) * 60e3;
  const ticks = [];
  for (let t = Math.ceil((now - windowMs) / tickMs) * tickMs; t <= now; t += tickMs) ticks.push(t);
  return (
    <div className={`live-chart ${axis ? "with-axes" : ""}`}>
      <div className="live-plot">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Internet traffic, last ${mins} minutes`} style={{ height: H }}>
        {grid.map((g) => <line key={g} x1="0" x2={W} y1={y(g)} y2={y(g)} className="live-grid" />)}
        {old.length > 1 && <polygon points={area(old)} className="live-down-area old" />}
        {old.length > 1 && <polyline points={line(old, "down")} className="live-down old" />}
        {old.length > 1 && <polyline points={line(old, "up")} className="live-up old" />}
        {points.length > 0 && old.length > 0 && <line x1={x(liveFrom)} x2={x(liveFrom)} y1="0" y2={H} className="live-mark" />}
        {points.length > 1 && <polygon points={area(points)} className="live-down-area" />}
        {points.length > 1 && <polyline points={line(points, "down")} className="live-down" />}
        {points.length > 1 && <polyline points={line(points, "up")} className="live-up" />}
        {overlay?.pts?.length > 1 && <polyline points={line(overlay.pts, "down")} className="live-overlay" />}
        {overlay?.pts?.length > 1 && <polyline points={line(overlay.pts, "up")} className="live-overlay up" />}
        {axis && ticks.map((t) => <line key={t} x1={x(t)} x2={x(t)} y1={H - 4} y2={H} className="live-grid" />)}
      </svg>
      {axis && grid.map((g) => <span key={g} className="live-y" style={{ top: `${(y(g) / H) * 100}%` }}>{bpsText(g)}</span>)}
      {axis && <span className="live-y" style={{ top: "100%" }}>0</span>}
      </div>
      {axis && (
        <div className="live-x">
          {ticks.map((t) => {
            const pct = (x(t) / W) * 100;
            // Kept inside the card at the edges.
            return <span key={t} style={{ left: `${pct}%`, transform: pct > 95 ? "translateX(-100%)" : pct < 5 ? "none" : undefined }}>{clock(t)}</span>;
          })}
        </div>
      )}
      {axis && <div className="live-axis small dim">
        <span>
          Last {mins} minutes{old.length ? "; before the dashed line: NetLens's 5-minute record, after it: live" : ""}
          {linkMbps ? ` · line ${linkMbps >= 1000 ? `${linkMbps / 1000} Gbps` : `${linkMbps} Mbps`}` : ""}
        </span>
      </div>}
    </div>
  );
}

// A small graph of one series' last minutes, both directions.
export function Spark({ pts, width = 90, height = 22, windowMs = LIVE_KEEP_MS }) {
  if (!pts?.length) return <svg width={width} height={height} aria-hidden="true" />;
  const now = pts[pts.length - 1][0];
  const top = Math.max(1e5, ...pts.flatMap((p) => [p[1], p[2]]));
  // Stretch over what there is until the window is full, so a fresh view is not a sliver.
  const span = Math.min(windowMs, Math.max(60e3, now - pts[0][0]));
  const x = (ts) => width - ((now - ts) / span) * width;
  const y = (v) => height - 1 - (v / top) * (height - 2);
  const line = (i) => pts.map((p) => `${x(p[0]).toFixed(1)},${y(p[i]).toFixed(1)}`).join(" ");
  return (
    <svg width={width} height={height} className="live-spark" aria-hidden="true">
      <polyline points={line(1)} className="live-down" />
      <polyline points={line(2)} className="live-up" />
    </svg>
  );
}

// The small card for Overview and the Network map: the last 10 minutes, now, the busiest device.
export function LiveMini({ title = "Live" }) {
  const { points, coarse, latest, connected, error } = useLive();
  const top = latest?.devices?.[0];
  return (
    <a className="card live-mini" href={href("live")} title="Open the live view">
      <div className="card-head">
        <span className="dim small">{title}</span>
        <span className={`small end ${error || !connected ? "warn" : "dim"}`}>{error ? "UniFi unreachable" : connected ? "live" : "connecting…"}</span>
      </div>
      <LiveChart points={points} coarse={coarse} windowMs={10 * 60e3} height={60} axis={false} />
      <span className="mono small">{latest ? <>↓ {bpsText(latest.down)} · ↑ {bpsText(latest.up)}</> : "—"}</span>
      {top && <span className="small dim">Busiest: {top.name} · ↓ {bpsText(top.down)} ↑ {bpsText(top.up)}</span>}
    </a>
  );
}
