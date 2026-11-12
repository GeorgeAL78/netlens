import { useMemo, useState } from "react";
import { LiveChart, Spark, bpsText, portDir, useLive } from "../live.jsx";

// Live (UU-C-258): the internet line over the last hour (NetLens's 5-minute record, then live
// readings every few seconds), and below it the busiest devices and every port, each with its own
// small graph. A click on a device or port draws its line over the main graph.

const last = (pts) => pts?.[pts.length - 1] || null;

export default function Live() {
  const { points, coarse, devices, ports, latest, error, connected, tickMs } = useLive();
  const [sel, setSel] = useState(null); // { kind: "device" | "port", key }
  const link = useMemo(() => Object.values(ports).find((p) => p.wan)?.speed || null, [ports]);
  const share = latest && link ? Math.round((Math.max(latest.down, latest.up) / (link * 1e6)) * 100) : null;

  const devList = Object.entries(devices)
    .map(([mac, d]) => ({ key: mac, ...d, now: last(d.pts) }))
    .filter((d) => d.now && d.now[0] >= (latest?.ts || 0) - 30e3)
    .sort((a, b) => b.now[1] + b.now[2] - (a.now[1] + a.now[2]))
    .slice(0, 12);
  const groups = new Map();
  for (const [key, p] of Object.entries(ports)) {
    const g = groups.get(p.mac) || { device: p.device, mac: p.mac, rows: [] };
    g.rows.push({ key, ...p, now: last(p.pts) });
    groups.set(p.mac, g);
  }
  for (const g of groups.values()) g.rows.sort((a, b) => a.idx - b.idx);

  // The selected series as { ts, down, up }, from your side.
  let overlay = null;
  let overlayName = null;
  if (sel?.kind === "device" && devices[sel.key]) {
    overlay = { pts: devices[sel.key].pts.map(([ts, down, up]) => ({ ts, down, up })) };
    overlayName = devices[sel.key].name;
  } else if (sel?.kind === "port" && ports[sel.key]) {
    const p = ports[sel.key];
    overlay = { pts: p.pts.map(([ts, to, from]) => ({ ts, ...portDir(p, to, from) })) };
    overlayName = `${p.device} port ${p.idx}${p.on ? ` (${p.on})` : ""}`;
  }
  const pick = (kind, key) => setSel(sel?.kind === kind && sel.key === key ? null : { kind, key });

  return (
    <div className="page wide capped">
      <div className="page-head">
        <div className="titles">
          <span className="dim small">Network · Live</span>
          <h1>Live</h1>
          <span className="muted">
            {latest ? <>↓ <strong className="mono">{bpsText(latest.down)}</strong> · ↑ <strong className="mono">{bpsText(latest.up)}</strong>{share != null ? ` · ${share}% of the line` : ""}</> : "Connecting…"}
            {latest?.demo ? " · demo data" : ""}
          </span>
        </div>
        <span className={`small ${error || !connected ? "warn" : "dim"}`}>
          {error ? `UniFi: ${error}` : connected ? `updates every ${Math.round(tickMs / 100) / 10} s while open; UniFi is only read while someone watches` : "reconnecting…"}
        </span>
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Internet</h2>
          <span className="hint">
            <span className="live-key down" /> download <span className="live-key up" /> upload
            {overlayName ? <> · <span className="live-key overlay" /> {overlayName} <button className="linkish small" onClick={() => setSel(null)}>clear</button></> : " · click a device or port below to draw it here"}
          </span>
        </div>
        <LiveChart points={points} coarse={coarse} overlay={overlay} linkMbps={link} />
      </section>

      <div className="live-lists">
        <section className="card">
          <div className="card-head">
            <h2>Busiest devices</h2>
            <span className="hint">right now; graphs: last 15 minutes</span>
          </div>
          {devList.length ? (
            <div className="scroll-x">
            <table className="t">
              <thead>
                <tr>
                  <th>Device</th>
                  <th />
                  <th className="num">↓</th>
                  <th className="num">↑</th>
                </tr>
              </thead>
              <tbody>
                {devList.map((d) => (
                  <tr key={d.key} className={`click ${sel?.kind === "device" && sel.key === d.key ? "live-sel" : ""}`} onClick={() => pick("device", d.key)}>
                    <td>
                      {d.name}
                      <div className="small dim">{d.via || "—"}{d.port != null ? ` · port ${d.port}` : ""}</div>
                    </td>
                    <td><Spark pts={d.pts} /></td>
                    <td className="num mono">{bpsText(d.now[1])}</td>
                    <td className="num mono dim">{bpsText(d.now[2])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          ) : (
            <p className="small dim" style={{ margin: 0 }}>Nothing moving right now.</p>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Ports</h2>
            <span className="hint">↓ to the device on it, ↑ from it; the internet port from your side</span>
          </div>
          {[...groups.values()].map((g) => (
            <div key={g.mac}>
              <h3>{g.device}</h3>
              <div className="scroll-x">
              <table className="t">
                <tbody>
                  {g.rows.map((p) => {
                    const { down, up } = portDir(p, p.now?.[1] || 0, p.now?.[2] || 0);
                    const load = p.speed ? Math.max(down, up) / (p.speed * 1e6) : null;
                    const pts = p.pts.map(([ts, to, from]) => { const v = portDir(p, to, from); return [ts, v.down, v.up]; });
                    return (
                      <tr key={p.key} className={`click ${sel?.kind === "port" && sel.key === p.key ? "live-sel" : ""}`} onClick={() => pick("port", p.key)}>
                        <td><span className="mono">{p.idx}</span>{p.on ? <span className="small dim"> {p.on}</span> : null}</td>
                        <td><Spark pts={pts} /></td>
                        <td className="num mono">{bpsText(down)}</td>
                        <td className="num mono dim">{bpsText(up)}</td>
                        <td className={`num mono ${load >= 0.8 ? "warn" : "dim"}`} title="The faster direction as a share of the port's speed">{load == null ? "—" : `${Math.round(load * 100)}%`}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            </div>
          ))}
          {!groups.size && <p className="small dim" style={{ margin: 0 }}>Waiting for the first reading…</p>}
        </section>
      </div>
    </div>
  );
}
