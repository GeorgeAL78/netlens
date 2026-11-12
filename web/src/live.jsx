import { useEffect, useRef, useState } from "react";

// Live traffic (UU-C-256): one event stream from /api/live while the page is visible. The server
// reads UniFi every few seconds only while someone watches; a hidden tab closes the stream.

const WINDOW_MS = 10 * 60 * 1000;
export const bpsText = (bps) => (bps == null ? "—" : bps >= 1e9 ? `${(bps / 1e9).toFixed(2)} Gbps` : bps >= 1e6 ? `${(bps / 1e6).toFixed(bps >= 1e8 ? 0 : 1)} Mbps` : `${Math.round(bps / 1e3)} kbps`);

export function useLive() {
  const [state, setState] = useState({ points: [], latest: null, error: null, connected: false, tickMs: 2500 });
  useEffect(() => {
    let es = null;
    const open = () => {
      if (es) return;
      es = new EventSource("/api/live");
      es.addEventListener("history", (e) => {
        const h = JSON.parse(e.data);
        setState({ points: h.points || [], latest: h.latest, error: h.error, connected: true, tickMs: h.tickMs || 2500 });
      });
      es.onmessage = (e) => {
        const f = JSON.parse(e.data);
        setState((s) => {
          if (f.error) return { ...s, error: f.error };
          const points = [...s.points, { ts: f.ts, down: f.down, up: f.up }].filter((p) => p.ts >= f.ts - WINDOW_MS);
          return { ...s, points, latest: f, error: null, connected: true };
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

// Download and upload over the last 10 minutes; the scale follows the busiest moment shown.
export function LiveChart({ points, linkMbps }) {
  const W = 720;
  const H = 150;
  const now = points.length ? points[points.length - 1].ts : Date.now();
  const top = Math.max(10e6, ...points.map((p) => Math.max(p.down, p.up))) * 1.15;
  const x = (ts) => W - ((now - ts) / WINDOW_MS) * W;
  const y = (v) => H - (v / top) * H;
  const line = (key) => points.map((p) => `${x(p.ts).toFixed(1)},${y(p[key]).toFixed(1)}`).join(" ");
  const area = points.length ? `${x(points[0].ts).toFixed(1)},${H} ${line("down")} ${x(now).toFixed(1)},${H}` : "";
  const grid = [0.25, 0.5, 0.75].map((f) => top * f);
  return (
    <div className="live-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Internet traffic, last 10 minutes">
        {grid.map((g) => <line key={g} x1="0" x2={W} y1={y(g)} y2={y(g)} className="live-grid" />)}
        {area && <polygon points={area} className="live-down-area" />}
        {points.length > 1 && <polyline points={line("down")} className="live-down" />}
        {points.length > 1 && <polyline points={line("up")} className="live-up" />}
      </svg>
      <div className="live-axis small dim">
        <span>10 min ago</span>
        <span>top of scale {bpsText(top)}{linkMbps ? ` · line ${linkMbps >= 1000 ? `${linkMbps / 1000} Gbps` : `${linkMbps} Mbps`}` : ""}</span>
        <span>now</span>
      </div>
    </div>
  );
}

export function LiveDevices({ devices }) {
  if (!devices?.length) return <p className="small dim" style={{ margin: 0 }}>Nothing moving right now.</p>;
  return (
    <table className="t">
      <thead>
        <tr>
          <th>Device</th>
          <th>Where</th>
          <th className="num">↓</th>
          <th className="num">↑</th>
        </tr>
      </thead>
      <tbody>
        {devices.map((d) => (
          <tr key={d.mac}>
            <td>{d.name}</td>
            <td className="small dim">{d.via || "—"}{d.port != null ? ` · port ${d.port}` : ""}</td>
            <td className="num mono">{bpsText(d.down)}</td>
            <td className="num mono dim">{bpsText(d.up)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Every port of the gateway and switches, live: ↓ to the device on it, ↑ from it; the internet
// port from your side (↓ download, ↑ upload), as everywhere else (UU-C-252).
export function LivePorts({ groups }) {
  if (!groups?.length) return null;
  return (
    <div className="wifi-channel-grid">
      {groups.map((g) => (
        <div key={g.mac} className="wifi-channels">
          <h3>{g.device}</h3>
          <table className="t">
            <thead>
              <tr>
                <th>Port</th>
                <th className="num">↓</th>
                <th className="num">↑</th>
                <th className="num" title="The faster direction as a share of the port's speed">Load</th>
              </tr>
            </thead>
            <tbody>
              {g.ports.map((p) => {
                const down = p.wan ? p.fromDevice : p.toDevice;
                const up = p.wan ? p.toDevice : p.fromDevice;
                const load = p.speed ? Math.max(down, up) / (p.speed * 1e6) : null;
                return (
                  <tr key={p.idx}>
                    <td>
                      <span className="mono">{p.idx}</span>
                      {p.on ? <span className="small dim"> {p.on}</span> : null}
                    </td>
                    <td className="num mono">{bpsText(down)}</td>
                    <td className="num mono dim">{bpsText(up)}</td>
                    <td className={`num mono ${load >= 0.8 ? "warn" : "dim"}`}>{load == null ? "—" : `${Math.round(load * 100)}%`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
