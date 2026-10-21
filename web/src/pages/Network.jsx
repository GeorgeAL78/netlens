import { useState } from "react";
import { ago, bytes, duration, go, href, shortDate, speed, useApi, wanNow } from "../lib.js";
import { Failed, Loading, healthClass, Bytes } from "../ui.jsx";

// Network — the map (UU-C-087): Internet → gateway → switches / access points → devices.
// Chip size is traffic in the last 15 minutes; the dot is health. Click anything for its panel.

const BAND = { ng: "2.4 GHz", na: "5 GHz", "6e": "6 GHz", "11be": "6 GHz" };
const BAND_SHORT = { ng: "2.4", na: "5", "6e": "6", "11be": "6" };
const KIND = { vm: "VM", container: "container" };
// "3 containers", "1 VM", "2 VMs · 5 containers"
const guestCount = (gs) => {
  const vm = gs.filter((g) => g.kind === "vm").length;
  const ct = gs.length - vm;
  return [vm ? `${vm} VM${vm === 1 ? "" : "s"}` : null, ct ? `${ct} container${ct === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ");
};
const kindOf = (t) => (/uap/.test(t || "") ? "Access point" : /usw/.test(t || "") ? "Switch" : /udm|ugw|uxg/.test(t || "") ? "Gateway" : "Device");

function size(b) {
  return b > 200e6 ? "l" : b > 10e6 ? "m" : "";
}

// A device chip. Wi-Fi chips show band and signal (UU-C-165); a host shows its VMs / containers
// folded into a second chip that opens them.
function Client({ c, sel, selC, guest = false }) {
  const [open, setOpen] = useState(false);
  const gs = c.guests || [];
  const wifi = !c.wired && c.radio;
  const chip = (
    <a
      className={`pill ${size(c.bytes15m)} ${sel ? "sel" : ""} ${guest ? "guest" : ""}`}
      href={href("network", null, { c: c.mac })}
      title={`${c.name} · ${bytes(c.bytes15m)} in 15 min${c.note ? ` · probably here: ${c.note}` : ""}${c.placed ? ` · last seen here ${ago(c.placed.ts)} — UniFi now only knows it is ${c.placed.nowAt}` : ""}`}
    >
      <span className={`status-dot ${healthClass(c.health)}`} />
      {c.name}
      {c.placed && <span className="dim small" aria-label="last seen here">↺</span>}
      {wifi && <span className={`mono small ${c.signal != null && c.signal < -75 ? "warn" : "dim"}`}>{BAND_SHORT[c.radio] || ""}{c.signal != null ? ` · ${c.signal}` : ""}</span>}
      {guest && c.kind && <span className="small dim">{KIND[c.kind]}{c.how === "presence" ? "?" : ""}</span>}
    </a>
  );
  if (!gs.length) return chip;
  return (
    <span className="host">
      {chip}
      <button className={`pill guests ${open ? "on" : ""}`} onClick={() => setOpen((v) => !v)} aria-expanded={open} title="Virtual machines and containers on this device">
        {open ? "▾" : "▸"} {guestCount(gs)}
      </button>
      {open && (
        <span className="guest-list">
          {gs.map((g) => <Client key={g.mac} c={g} sel={selC === g.mac} selC={selC} guest />)}
        </span>
      )}
    </span>
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
  const flat = [...all.flatMap((n) => n.clients), ...data.loose];
  const hostOf = route.query.c ? flat.find((h) => (h.guests || []).some((g) => g.mac === route.query.c)) || null : null;
  const client = route.query.c ? flat.find((c) => c.mac === route.query.c) || hostOf?.guests.find((g) => g.mac === route.query.c) || null : null;
  const node = route.query.n ? all.find((n) => n.mac === route.query.n) : null;
  // The Internet box (UU-C-176): line details and the public IP's history (90 days).
  if (route.query.n === "internet" && data.wan) {
    const w = data.wan;
    const link = data.gateway?.uplink?.speed;
    return (
      <aside className="panel" aria-label="Internet">
        <span className="tag dim">INTERNET</span>
        <h2 style={{ fontSize: 22 }}>{w.isp || "WAN"}</h2>
        <div className="kv">
          <div><span>Status</span><span className={w.status === "ok" ? "ok" : "warn"}>{w.status === "ok" ? "OK" : w.status || "unknown"}{w.latency != null ? ` · ${w.latency} ms` : ""}</span></div>
          {w.availability != null && <div><span>Up</span><span className="mono">{+Number(w.availability).toFixed(2)}%</span></div>}
          {wanNow(w, link) && <div><span>Right now</span><span className="mono">{wanNow(w, link)}</span></div>}
          {link && <div><span>WAN link</span><span className="mono">{speed(link)}</span></div>}
          {w.ip && <div><span>Public IP</span><span className="mono">{w.ip}</span></div>}
        </div>
        {w.ipHistory?.length > 0 && (
          <>
            <h2>Public IP history</h2>
            <div className="kv">
              {w.ipHistory.map((r, i) => (
                <div key={r.from}><span className="mono">{r.ip}</span><span className="small dim">{shortDate(r.from)} – {i === 0 ? "now" : shortDate(r.to)}</span></div>
              ))}
            </div>
            <p className="dim small" style={{ margin: 0 }}>Recorded with every update, kept 90 days.</p>
          </>
        )}
      </aside>
    );
  }
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
          <div><span>Last 15 minutes</span><span className="mono"><Bytes n={client.bytes15m} /></span></div>
          <div><span>Connected</span><span className="mono">{duration(client.uptime)}</span></div>
          {client.kind && <div><span>Kind</span><span>{client.kind === "vm" ? `Virtual machine${client.platform ? ` · ${client.platform}` : ""}` : "Container (made-up network address)"}</span></div>}
          {client.placed && <div><span>Place</span><span>last seen here {shortDate(client.placed.ts)}; UniFi now only knows it is {client.placed.nowAt}</span></div>}
          {hostOf && <div><span>Runs on</span><span>{hostOf.name}{client.how === "presence" ? " (probably)" : client.how === "confirmed" ? " (set by you)" : ""}</span></div>}
          {client.note && <div><span /><span className="dim small">{client.note}</span></div>}
          {client.guests?.length > 0 && <div><span>Runs</span><span>{guestCount(client.guests)}</span></div>}
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
  return null;
}

// The real topology (UU-C-093): each switch / AP hangs off the device and port it reports as its
// uplink; wired devices are grouped by the port they are on.
function portSpeed(node, idx) {
  const p = (node.ports || []).find((x) => x.idx === idx);
  return p?.up && p.speed ? speed(p.speed) : null;
}

function Branch({ node, all, byName, gateway, sel, selC, root = false }) {
  const parentOf = (n) => (n.uplink?.device && byName[n.uplink.device]) || gateway;
  const kids = all.filter((n) => n !== gateway && n !== node && parentOf(n) === node);
  const wired = node.clients.filter((c) => c.wired);
  const wifi = node.clients.filter((c) => !c.wired);
  const ports = new Map();
  const at = (p) => {
    const k = p ?? "?";
    if (!ports.has(k)) ports.set(k, { kids: [], clients: [] });
    return ports.get(k);
  };
  for (const k of kids) at(k.uplink?.port).kids.push(k);
  for (const c of wired) at(c.port).clients.push(c);
  const order = [...ports.keys()].sort((a, b) => (a === "?" ? 1 : b === "?" ? -1 : a - b));
  const isAp = /uap/.test(node.type || "");
  return (
    <div className={`branch-tree ${root ? "root" : ""}`}>
      <a className={`node ${root ? "gw" : ""} ${sel === node.mac ? "sel" : ""}`} href={href("network", null, { n: node.mac })}>
        <span className="small" style={{ color: root ? "var(--accent)" : "var(--dim)" }}>
          {kindOf(node.type)}{node.online === false ? " · offline" : ""}
        </span>
        <strong>{node.name}</strong>
        {root ? (
          <span className="mono small dim">{node.cpu != null ? `CPU ${Math.round(node.cpu)}%` : ""}{node.temp != null ? ` · ${Math.round(node.temp)} °C` : ""} · up {duration(node.uptime)}</span>
        ) : (
          <NodeStat n={node} />
        )}
      </a>
      {(order.length > 0 || (isAp && wifi.length > 0)) && (
        <div className="ports">
          {order.map((p) => {
            const g = ports.get(p);
            const sp = p === "?" ? null : portSpeed(node, p);
            return (
              <div key={p} className="port-row">
                <span className="port-label">
                  <strong>{p === "?" ? "Port ?" : `Port ${p}`}</strong>
                  <span className="mono small dim">{[sp, g.clients.length > 1 ? `${g.clients.length} devices` : null].filter(Boolean).join(" · ")}</span>
                </span>
                <div className="port-body">
                  {g.kids.map((k) => (
                    <Branch key={k.mac} node={k} all={all} byName={byName} gateway={gateway} sel={sel} selC={selC} />
                  ))}
                  {g.clients.length > 0 && (
                    <div className="chips">
                      {g.clients.map((c) => <Client key={c.mac} c={c} sel={selC === c.mac} selC={selC} />)}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {isAp && wifi.length > 0 && (
            <div className="port-row">
              <span className="port-label">
                <strong>Wi-Fi</strong>
                <span className="mono small dim">{wifi.length} devices</span>
              </span>
              <div className="port-body">
                <div className="chips">{wifi.map((c) => <Client key={c.mac} c={c} sel={selC === c.mac} selC={selC} />)}</div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Tree({ data, sel, selC }) {
  const gateway = data.gateway;
  if (!gateway) return <div className="card empty">No gateway data yet.</div>;
  const all = [gateway, ...data.nodes];
  const byName = Object.fromEntries(all.map((n) => [n.name, n]));
  return (
    <div className="map">
      <a className={`node internet ${sel === "internet" ? "sel" : ""}`} href={href("network", null, { n: "internet" })}>
        <span className="dim small">Internet</span>
        <strong>{data.wan?.isp || "WAN"}</strong>
        <span className={`mono small ${data.wan?.status === "ok" ? "ok" : "warn"}`}>
          {data.wan?.status === "ok" ? "OK" : data.wan?.status || "unknown"}
          {data.wan?.latency != null ? ` · ${data.wan.latency} ms` : ""}
        </span>
        {data.wan?.ip ? <span className="mono small">{data.wan.ip}</span> : null}
        {data.wan?.availability != null ? <span className="mono small dim">up {+Number(data.wan.availability).toFixed(2)}%</span> : null}
        {wanNow(data.wan, gateway.uplink?.speed) ? <span className="mono small">{wanNow(data.wan, gateway.uplink?.speed)}</span> : null}
        {gateway.uplink?.speed ? <span className="mono small dim">WAN link {speed(gateway.uplink.speed)}</span> : null}
      </a>
      <Branch node={gateway} all={all} byName={byName} gateway={gateway} sel={sel} selC={selC} root />
      {data.loose.length > 0 && (
        <div className="port-row" style={{ marginTop: 8 }}>
          <span className="port-label">
            <strong>Elsewhere</strong>
            <span className="small dim">behind other devices</span>
          </span>
          <div className="port-body"><div className="chips">{data.loose.map((c) => <Client key={c.mac} c={c} sel={selC === c.mac} selC={selC} />)}</div></div>
        </div>
      )}
    </div>
  );
}

export default function Network({ route }) {
  const { data, error, loading, reload } = useApi("/api/network", 60 * 1000);
  const sel = route.query.n || null;
  const selC = route.query.c || null;
  return (
    <div className="split">
      <div className="main">
        <div className="page wide">
          <div className="page-head">
            <div className="titles">
              <span className="dim small">Network · live, refreshes every minute</span>
              <h1>Your network</h1>
            </div>
            <div className="legend">
              <span><span className="status-dot" style={{ marginRight: 6 }} />healthy</span>
              <span><span className="status-dot warn" style={{ marginRight: 6 }} />weak signal or slow link</span>
              <span><span className="status-dot off" style={{ marginRight: 6 }} />offline</span>
              <span className="dim">· bigger chip = more data in 15 min · Wi-Fi: band (GHz) · signal (dBm) · ↺ last seen there · click anything for details</span>
            </div>
          </div>
          {error && <Failed error={error} reload={reload} />}
          {!data && loading && <Loading />}
          {data && <Tree data={data} sel={sel} selC={selC} />}
        </div>
      </div>
      {data && <Panel data={data} route={route} />}
    </div>
  );
}
