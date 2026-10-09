import { bytes, duration, go, href, speed, useApi } from "../lib.js";
import { Failed, Loading, healthClass } from "../ui.jsx";

// Network — the map (UU-C-087): Internet → gateway → switches / access points → devices.
// Chip size is traffic in the last 15 minutes; the dot is health. Click anything for its panel.

const BAND = { ng: "2.4 GHz", na: "5 GHz", "6e": "6 GHz", "11be": "6 GHz" };
const kindOf = (t) => (/uap/.test(t || "") ? "Access point" : /usw/.test(t || "") ? "Switch" : /udm|ugw|uxg/.test(t || "") ? "Gateway" : "Device");

function size(b) {
  return b > 200e6 ? "l" : b > 10e6 ? "m" : "";
}

function Client({ c, sel }) {
  return (
    <a
      className={`pill ${size(c.bytes15m)} ${sel ? "sel" : ""}`}
      href={href("network", null, { c: c.mac })}
      title={`${c.name} · ${bytes(c.bytes15m)} in 15 min`}
    >
      <span className={`status-dot ${healthClass(c.health)}`} />
      {c.name}
    </a>
  );
}

function NodeStat({ n }) {
  if (/uap/.test(n.type || "")) {
    const busy = Math.max(0, ...n.radios.map((r) => r.util || 0));
    return <span className="mono small dim">{n.clients.length} clients · {busy}% busy</span>;
  }
  if (/usw/.test(n.type || "")) {
    const up = n.ports.filter((p) => p.up).length;
    return <span className="mono small dim">{up}/{n.ports.length} ports up</span>;
  }
  return <span className="mono small dim">{n.clients.length} devices</span>;
}

function Panel({ data, route }) {
  const all = [data.gateway, ...data.nodes].filter(Boolean);
  const client = route.query.c ? [...all.flatMap((n) => n.clients), ...data.loose].find((c) => c.mac === route.query.c) : null;
  const node = route.query.n ? all.find((n) => n.mac === route.query.n) : null;
  if (client) {
    return (
      <aside className="panel" aria-label="Selected device">
        <span className={`tag ${client.health === "warn" ? "warn" : client.health === "off" ? "dim" : "ok"}`}>
          {client.health === "warn" ? (client.wired ? "SLOW LINK" : "WEAK SIGNAL") : client.health === "off" ? "OFFLINE" : "HEALTHY"}
        </span>
        <h2 style={{ fontSize: 22 }}>{client.name}</h2>
        <div className="kv">
          <div><span>Connection</span><span>{client.wired ? `Wired${client.port != null ? ` · port ${client.port}` : ""}` : `Wi-Fi ${BAND[client.radio] || ""}${client.essid ? ` · ${client.essid}` : ""}`}</span></div>
          {client.wired ? <div><span>Link speed</span><span className="mono">{speed(client.speed)}</span></div> : <div><span>Signal</span><span className={`mono ${client.signal < -80 ? "warn" : ""}`}>{client.signal ?? "—"} dBm</span></div>}
          <div><span>Last 15 minutes</span><span className="mono">{bytes(client.bytes15m)}</span></div>
          <div><span>Connected</span><span className="mono">{duration(client.uptime)}</span></div>
        </div>
        <a className="btn primary" href={href("device", client.mac)}>Open {client.name}</a>
      </aside>
    );
  }
  if (node) {
    const isAp = /uap/.test(node.type || "");
    const isSw = /usw/.test(node.type || "");
    const byBand = {};
    const bySsid = {};
    for (const c of node.clients) {
      if (c.wired) continue;
      byBand[BAND[c.radio] || c.radio || "?"] = (byBand[BAND[c.radio] || c.radio || "?"] || 0) + 1;
      if (c.essid) bySsid[c.essid] = (bySsid[c.essid] || 0) + 1;
    }
    return (
      <aside className="panel" aria-label="Selected equipment">
        <span className="tag dim">{kindOf(node.type).toUpperCase()} · {node.model}</span>
        <h2 style={{ fontSize: 22 }}>{node.name}</h2>
        <div className="kv">
          <div><span>Status</span><span className={node.online ? "ok" : "bad"}>{node.online ? "online" : "offline"}</span></div>
          {node.cpu != null && <div><span>CPU · memory</span><span className="mono">{Math.round(node.cpu)}% · {Math.round(node.mem ?? 0)}%</span></div>}
          {node.temp != null && <div><span>Temperature</span><span className={`mono ${node.temp >= 80 ? "warn" : ""}`}>{Math.round(node.temp)} °C</span></div>}
          <div><span>Up</span><span className="mono">{duration(node.uptime)}</span></div>
          {node.uplink && <div><span>Uplink</span><span>{node.uplink.device || "—"}{node.uplink.port != null ? ` port ${node.uplink.port}` : ""}{node.uplink.speed ? ` · ${speed(node.uplink.speed)}` : ""}</span></div>}
        </div>
        {isAp && (
          <>
            <h2>Radios</h2>
            <div className="kv">
              {node.radios.map((r) => (
                <div key={r.radio}><span>{BAND[r.radio] || r.radio} · ch {r.channel}</span><span className="mono">{r.clients ?? 0} clients · {r.util ?? 0}% busy</span></div>
              ))}
            </div>
            <h2>Clients by band</h2>
            <div className="kv">{Object.entries(byBand).map(([b, n]) => <div key={b}><span>{b}</span><span className="mono">{n}</span></div>)}</div>
            {Object.keys(bySsid).length > 0 && (
              <>
                <h2>By Wi-Fi network</h2>
                <div className="kv">{Object.entries(bySsid).map(([s, n]) => <div key={s}><span>{s}</span><span className="mono">{n}</span></div>)}</div>
              </>
            )}
          </>
        )}
        {(isSw || node.ports.length > 0) && (
          <>
            <h2>Ports</h2>
            <table className="t">
              <thead><tr><th>#</th><th>Name</th><th className="num">Speed</th><th className="num">PoE</th><th className="num">Errors</th></tr></thead>
              <tbody>
                {node.ports.map((p) => (
                  <tr key={p.idx}>
                    <td className="mono">{p.idx}</td>
                    <td className={p.up ? "" : "dim"}>{p.name || `Port ${p.idx}`}</td>
                    <td className={`num ${p.up && p.speed && p.speed <= 100 ? "warn" : p.up ? "" : "dim"}`}>{p.up ? speed(p.speed) : "down"}</td>
                    <td className="num dim">{p.poe ? `${p.poe.toFixed ? p.poe.toFixed(1) : p.poe} W` : "—"}</td>
                    <td className={`num ${(p.rxErrors || 0) + (p.txErrors || 0) > 0 ? "warn" : "dim"}`}>{(p.rxErrors || 0) + (p.txErrors || 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </aside>
    );
  }
  return (
    <aside className="panel" aria-label="Help">
      <h2>Your network, live</h2>
      <p className="muted" style={{ margin: 0 }}>
        Click a device for its connection and traffic, or an access point or switch for its radios, clients and ports. Larger chips moved more data in the last 15 minutes.
      </p>
      <div className="legend" style={{ flexDirection: "column", gap: 8 }}>
        <span><span className="status-dot" style={{ marginRight: 8 }} />healthy</span>
        <span><span className="status-dot warn" style={{ marginRight: 8 }} />weak signal or slow link</span>
        <span><span className="status-dot off" style={{ marginRight: 8 }} />offline</span>
      </div>
    </aside>
  );
}

export default function Network({ route }) {
  const { data, error, loading, reload } = useApi("/api/network", 60 * 1000);
  const sel = route.query.n || null;
  const selC = route.query.c || null;
  return (
    <div className="split">
      <div className="main">
        <div className="page">
          <div className="page-head">
            <div className="titles">
              <span className="dim small">Network · live, refreshes every minute</span>
              <h1>Your network</h1>
            </div>
          </div>
          {error && <Failed error={error} reload={reload} />}
          {!data && loading && <Loading />}
          {data && (
            <div className="tree">
              <div className="node" style={{ gridRow: `span ${Math.max(1, data.nodes.length + 1)}`, alignSelf: "center", cursor: "default" }}>
                <span className="dim small">Internet</span>
                <strong>{data.wan?.isp || "WAN"}</strong>
                <span className={`mono small ${data.wan?.status === "ok" ? "ok" : "warn"}`}>
                  {data.wan?.status === "ok" ? "OK" : data.wan?.status || "unknown"}
                  {data.wan?.latency != null ? ` · ${data.wan.latency} ms` : ""}
                </span>
                {data.wan?.availability != null && <span className="mono small dim">{data.wan.availability}% up</span>}
              </div>
              <div className="wire strong" style={{ gridRow: `span ${Math.max(1, data.nodes.length + 1)}` }} />
              {data.gateway ? (
                <a
                  className={`node gw ${sel === data.gateway.mac ? "sel" : ""}`}
                  href={href("network", null, { n: data.gateway.mac })}
                  style={{ gridRow: `span ${Math.max(1, data.nodes.length + 1)}`, alignSelf: "center" }}
                >
                  <span className="small" style={{ color: "var(--accent)" }}>Gateway</span>
                  <strong>{data.gateway.name}</strong>
                  {data.gateway.cpu != null && <span className="mono small dim">CPU {Math.round(data.gateway.cpu)}%{data.gateway.temp != null ? ` · ${Math.round(data.gateway.temp)} °C` : ""}</span>}
                  <span className="mono small dim">up {duration(data.gateway.uptime)}</span>
                </a>
              ) : (
                <div className="node" style={{ gridRow: "span 1" }}>No gateway data yet</div>
              )}
              {[...data.nodes, ...(data.gateway && data.gateway.clients.length ? [{ ...data.gateway, direct: true }] : [])].map((n) => [
                <div key={`${n.mac}-w`} className="wire" style={{ gridColumn: 4 }} />,
                <div key={n.mac} className="branch" style={{ gridColumn: 5 }}>
                  {n.direct ? (
                    <span className="node" style={{ cursor: "default" }}>
                      <span className="dim small">Gateway ports</span>
                      <strong>Wired to the gateway</strong>
                    </span>
                  ) : (
                    <a className={`node ${sel === n.mac ? "sel" : ""}`} href={href("network", null, { n: n.mac })}>
                      <span className="dim small">{kindOf(n.type)}{n.online ? "" : " · offline"}</span>
                      <strong>{n.name}</strong>
                      <NodeStat n={n} />
                    </a>
                  )}
                  {n.clients.map((c) => <Client key={c.mac} c={c} sel={selC === c.mac} />)}
                  {!n.clients.length && <span className="dim small">no devices right now</span>}
                </div>,
              ])}
              {data.loose.length > 0 && [
                <div key="loose-w" className="wire" style={{ gridColumn: 4 }} />,
                <div key="loose" className="branch" style={{ gridColumn: 5 }}>
                  <span className="node" style={{ cursor: "default" }}><span className="dim small">Behind other devices</span><strong>Other</strong></span>
                  {data.loose.map((c) => <Client key={c.mac} c={c} sel={selC === c.mac} />)}
                </div>,
              ]}
            </div>
          )}
        </div>
      </div>
      {data && <Panel data={data} route={route} />}
    </div>
  );
}
