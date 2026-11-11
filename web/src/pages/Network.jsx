import { createContext, useContext, useEffect, useState } from "react";
import { ago, bytes, clock, duration, go, href, shortDate, speed, useApi, wanNow, splitTip } from "../lib.js";
import { Bars, Failed, Loading, healthClass, Bytes, Split, WanDays } from "../ui.jsx";

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
// The map's time (UU-C-213): null = live. Links on the map keep it, so a device picked on a past
// map opens as it was then.
const AtCtx = createContext(null);
const mapHref = (at, q) => href("network", null, at ? { ...q, at } : q);

const kindOf = (t) => (/uap/.test(t || "") ? "Access point" : /usw/.test(t || "") ? "Switch" : /udm|ugw|uxg/.test(t || "") ? "Gateway" : "Device");

// A switch, access point or gateway over time (UU-C-198), from NetLens' own samples.
const HISTORY_DAYS = [[1, "24 hours"], [7, "7 days"], [30, "30 days"], [90, "90 days"]];
const EVENT_CLASS = { bad: "bad", warn: "warn", ok: "ok" };
// "5,333 · 0.13%"; a share below 0.01% reads "<0.01%" (UU-C-245).
// Short for the panel (UU-C-247): the share when it is 0.01% or more, else the count; both in the tooltip.
const dropText = (n, share) => (n == null ? "—" : n === 0 ? "0" : share >= 0.0001 ? `${(share * 100).toFixed(share >= 0.1 ? 0 : 2)}%` : n.toLocaleString());
const dropTip = (n, share) => (n ? `${n.toLocaleString()} packets dropped, ${share >= 0.0001 ? `${(share * 100).toFixed(2)}%` : "under 0.01%"} of the port's packets` : "");
const peakText = (bps) => (bps >= 1e6 ? speed(+(bps / 1e6).toFixed(bps >= 1e8 ? 0 : 1)) : `${Math.round(bps / 1e3)} kbps`);

function History({ mac }) {
  const [days, setDays] = useState(1);
  const { data, error, loading, reload } = useApi(`/api/network/history?mac=${encodeURIComponent(mac)}&days=${days}`);
  const when = (t) => (days === 1 ? clock(t) : shortDate(t));
  return (
    <>
      <h2>History</h2>
      <div className="history-range" role="group" aria-label="History period">
        {HISTORY_DAYS.map(([d, label]) => (
          <button key={d} className={`btn quiet ${days === d ? "on" : ""}`} aria-pressed={days === d} onClick={() => setDays(d)}>{label}</button>
        ))}
      </div>
      {error && <Failed error={error} reload={reload} />}
      {!data && loading && <Loading />}
      {data && !data.samples && <p className="dim small" style={{ margin: 0 }}>Nothing recorded in this period.</p>}
      {data?.samples > 0 && (
        <>
          {data.radios.map((r) => (
            <div key={r.radio} className="history-radio">
              <div className="kv"><div><span>{r.band || r.radio} busy</span><span className="mono">{r.avgUtil ?? 0}% average · {r.peakUtil ?? 0}% peak</span></div></div>
              <Bars
                short
                max={100}
                items={r.series.map((s) => ({
                  value: s.util || 0,
                  nodata: s.util == null,
                  tip: s.util == null ? `${when(s.t)}: nothing recorded` : `${when(s.t)}: ${s.util}% busy, ${s.peak}% peak, ${s.clients} clients, channel ${s.channel}`,
                }))}
              />
            </div>
          ))}
          {data.ports.length > 0 && (
            <table className="t">
              <thead><tr><th>Port</th><th className="num" title="To the device on the port ↓, from it ↑">Traffic</th><th className="num">Peak</th><th className="num" title="Packets the port threw away in this period, and their share of its packets (the worse direction)">Dropped</th><th className="num">Changes</th><th className="num">New errors</th>{data.ports.some((p) => p.poePeak) && <th className="num">PoE peak</th>}</tr></thead>
              <tbody>
                {data.ports.map((p) => (
                  <tr key={p.idx}>
                    <td>{p.name || `Port ${p.idx}`}</td>
                    <td className="num mono">{p.toDevice != null ? <>{bytes(p.toDevice + (p.fromDevice || 0))}<Split down={p.wan ? p.fromDevice : p.toDevice} up={p.wan ? p.toDevice : p.fromDevice} /></> : "—"}</td>
                    <td className="num mono dim">{p.peakBps ? (p.peakBps >= 1e6 ? speed(+(p.peakBps / 1e6).toFixed(p.peakBps >= 1e8 ? 0 : 1)) : `${Math.round(p.peakBps / 1e3)} kbps`) : "—"}</td>
                    <td className={`num mono ${p.dropShare >= 0.005 ? "warn" : "dim"}`} title={p.dropped != null ? `${dropTip(p.dropped, p.dropShare)} · ${p.droppedTo.toLocaleString()} on the way to the device · ${p.droppedFrom.toLocaleString()} coming from it` : undefined}>{dropText(p.dropped, p.dropShare)}</td>
                    <td className="num">{p.changes}</td>
                    <td className={`num ${p.errors > 0 ? "warn" : "dim"}`}>{p.errors}</td>
                    {data.ports.some((q) => q.poePeak) && <td className="num dim">{p.poePeak ? `${p.poePeak.toFixed(1)} W` : "—"}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {data.events.length > 0 ? (
            <div className="kv">
              {data.events.map((e, i) => (
                <div key={`${e.ts}-${i}`}>
                  <span className="small dim">{when(e.ts)}</span>
                  <span className={EVENT_CLASS[e.level] || ""} style={{ textAlign: "right" }}>{e.what}{e.detail ? <span className="dim small"> · {e.detail}</span> : null}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="dim small" style={{ margin: 0 }}>No restarts, channel changes or port changes in this period.</p>
          )}
          {data.moreEvents > 0 && <p className="dim small" style={{ margin: 0 }}>{data.moreEvents} earlier changes not listed.</p>}
          <p className="dim small" style={{ margin: 0 }}>Recorded with every update, kept 90 days.</p>
        </>
      )}
    </>
  );
}

function Panel({ data, route, closeHref }) {
  const close = <a className="iconbtn panel-close" href={closeHref} aria-label="Close" title="Close (Esc)">×</a>;
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
        {close}
        <span className="tag dim">INTERNET</span>
        <h2 style={{ fontSize: 22 }}>{w.isp || "WAN"}</h2>
        <div className="kv">
          <div><span>Status</span><span className={w.status === "ok" ? "ok" : "warn"}>{w.status === "ok" ? "OK" : w.status || "unknown"}{w.latency != null ? ` · ${w.latency} ms` : ""}</span></div>
          {/* UniFi's own check (UU-C-252): answered pings to its test target, over its window since the
              gateway started, so it can differ from UniFi's rounded dashboard figure. */}
          {w.availability != null && (
            <div title="UniFi's internet check: the share of its pings (to ping.ui.com) answered, since the gateway last started. The Internet tab has the outages NetLens saw over any period.">
              <span>Reachable</span>
              <span className="mono">{+Number(w.availability).toFixed(2)}%{w.availabilityPeriod ? <span className="dim"> · last {w.availabilityPeriod >= 172800 ? `${Math.round(w.availabilityPeriod / 86400)} days` : `${Math.round(w.availabilityPeriod / 3600)} h`}</span> : null}</span>
            </div>
          )}
          {wanNow(w, link) && <div><span>Right now</span><span className="mono">{wanNow(w, link)}</span></div>}
          {link && <div><span>WAN link</span><span className="mono">{speed(link)}</span></div>}
          {w.ip && <div><span>Public IP</span><span className="mono">{w.ip}</span></div>}
        </div>
        {/* Per day (UU-C-254); the Internet tab has more days and the outages. */}
        {data.wanDays?.length > 0 && (
          <>
            <h2>Last 7 days</h2>
            <WanDays days={data.wanDays} linkMbps={link} />
            <a className="small" href={href("internet")}>More on the Internet tab</a>
          </>
        )}
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
        {close}
        <span className={`tag ${client.health === "warn" ? "warn" : client.health === "off" ? "dim" : "ok"}`}>
          {client.health === "warn" ? (client.wired ? "SLOW LINK" : "WEAK SIGNAL") : client.health === "off" ? "OFFLINE" : "HEALTHY"}
        </span>
        <h2 style={{ fontSize: 22 }}>{client.name}</h2>
        <div className="kv">
          <div><span>Connection</span><span>{client.wired ? `Wired${client.port != null ? ` · port ${client.port}` : ""}` : `Wi-Fi ${BAND[client.radio] || ""}${client.essid ? ` · ${client.essid}` : ""}`}</span></div>
          {client.wired ? <div><span>Link speed</span><span className="mono">{speed(client.speed)}</span></div> : <div><span>Signal</span><span className={`mono ${client.signal < -80 ? "warn" : ""}`}>{client.signal ?? "—"} dBm</span></div>}
          <div><span>Last 15 minutes</span><span className="mono" style={{ textAlign: "right" }}><Bytes n={client.bytes15m} /><Split down={client.down15m} up={client.up15m} /></span></div>
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
    const isGwNode = /udm|ugw|uxg/.test(node.type || "");
    const isSw = /usw/.test(node.type || "");
    const hasPoe = (node.ports || []).some((p) => p.poe != null && p.poe !== 0) || node.poeMax > 0;
    const byBand = {};
    const bySsid = {};
    for (const c of node.clients) {
      if (c.wired) continue;
      byBand[BAND[c.radio] || c.radio || "?"] = (byBand[BAND[c.radio] || c.radio || "?"] || 0) + 1;
      if (c.essid) bySsid[c.essid] = (bySsid[c.essid] || 0) + 1;
    }
    return (
      <aside className="panel" aria-label="Selected equipment">
        {close}
        <span className="tag dim">{kindOf(node.type).toUpperCase()} · {node.model}{node.modelCode ? ` (${node.modelCode})` : ""}</span>
        <h2 style={{ fontSize: 22 }}>{node.name}</h2>
        <div className="kv">
          <div><span>Status</span><span className={node.online ? "ok" : "bad"}>{node.online ? "online" : "offline"}</span></div>
          {node.overheating && <div><span>Heat</span><span className="bad">UniFi reports it overheating</span></div>}
          {node.cpu != null && <div><span>CPU · memory</span><span className="mono">{Math.round(node.cpu)}% · {Math.round(node.mem ?? 0)}%</span></div>}
          {node.temp != null && <div><span>Temperature</span><span className={`mono ${node.temp >= 80 ? "warn" : ""}`}>{Math.round(node.temp)} °C</span></div>}
          <div><span>Up</span><span className="mono">{duration(node.uptime)}</span></div>
          {node.uplink && <div><span>Uplink</span><span>{node.uplink.device || (isGwNode ? "Internet" : "—")}{node.uplink.port != null ? ` port ${node.uplink.port}` : ""}{node.uplink.speed ? ` · ${speed(node.uplink.speed)}` : ""}</span></div>}
          {node.ip && <div><span>{isGwNode ? "LAN address" : "Address"}</span><span className="mono">{node.ip}</span></div>}
          {isGwNode && data.unifi ? (
            <div><span>UniFi</span><span className="mono">OS {data.unifi.os || node.firmware || "?"} · Network {data.unifi.network}{data.unifi.updateAvailable ? " (update available)" : ""}</span></div>
          ) : (
            node.firmware && <div><span>Firmware</span><span className="mono">{node.firmware}</span></div>
          )}
          {node.upgradable && <div><span>Update</span><span className="ok">{node.upgradeTo ? `${node.upgradeTo} available` : "available"}</span></div>}
          {node.eol && <div><span>Support</span><span className="warn">End of life: UniFi gives it no more firmware</span></div>}
          {node.satisfaction != null && <div><span>Wi-Fi experience</span><span className={`mono ${node.satisfaction < 70 ? "warn" : ""}`}>{node.satisfaction}%</span></div>}
          {node.poeMax > 0 && <div><span>PoE budget</span><span className="mono">{node.poeUsed != null ? `${+Number(node.poeUsed).toFixed(1)} of ` : ""}{node.poeMax} W</span></div>}
        </div>
        {isAp && (
          <>
            <h2>Radios</h2>
            <div className="kv">
              {node.radios.map((r) => (
                <div key={r.radio}><span>{BAND[r.radio] || r.radio} · ch {r.channel}{r.width ? ` · ${r.width} MHz` : ""}</span><span className="mono" style={{ whiteSpace: "nowrap" }}>{r.clients ?? 0} clients · {r.util ?? 0}% busy</span></div>
              ))}
            </div>
            <h2>Clients by band</h2>
            <div className="kv">{Object.entries(byBand).sort(([x], [y]) => parseFloat(x) - parseFloat(y)).map(([b, n]) => <div key={b}><span>{b}</span><span className="mono">{n}</span></div>)}</div>
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
            <h2>Ports <span className="dim small">· busiest and drops: last 24 hours</span></h2>
            <table className="t">
              <thead><tr><th>Port</th><th className="num">Speed</th><th className="num" title="Last 15 minutes: to the device on the port ↓, from it ↑ (the internet port: ↓ download, ↑ upload)">15 min</th><th className="num" title="The busiest 5 minutes in the last 24 hours, as a share of the link's speed (the faster direction)">Busiest</th><th className="num" title="Packets the port threw away in the last 24 hours, and their share of its packets (the worse direction)">Drops</th>{hasPoe && <th className="num">PoE</th>}<th className="num">Errors</th></tr></thead>
              <tbody>
                {node.ports.map((p) => (
                  <tr key={p.idx}>
                    {/* One column for the port (UU-C-247): its own name only when someone gave it one. */}
                    <td className={`mono ${p.up ? "" : "dim"}`}>{p.idx}{p.name && p.name !== `Port ${p.idx}` ? <span className="dim small"> {p.name}</span> : null}</td>
                    <td className={`num ${p.up && p.speed && p.speed <= 100 && !p.usualSpeed ? "warn" : p.up ? "" : "dim"}`} title={p.usualSpeed ? "The usual speed of the device on it" : undefined}>{p.up ? speed(p.speed) : "down"}</td>
                    <td className="num mono dim">{p.toDevice15m != null ? <>{bytes(p.toDevice15m + p.fromDevice15m)}{/* The internet port reads from your side (UU-C-252): ↓ what came in from the ISP, ↑ what went out. */}<Split down={p.wan ? p.fromDevice15m : p.toDevice15m} up={p.wan ? p.toDevice15m : p.fromDevice15m} /></> : "—"}</td>
                    <td className={`num mono ${p.peak24h?.share >= 0.8 ? "warn" : "dim"}`} title={p.peak24h ? `${peakText(p.peak24h.bps)} at ${clock(p.peak24h.at)}` : undefined}>{p.peak24h?.share != null ? `${Math.max(1, Math.round(p.peak24h.share * 100))}%` : p.peak24h ? peakText(p.peak24h.bps) : "—"}</td>
                    <td className={`num mono ${p.drops24h?.share >= 0.005 ? "warn" : "dim"}`} title={p.drops24h ? `${dropTip(p.drops24h.toDevice + p.drops24h.fromDevice, p.drops24h.share)} · ${p.drops24h.toDevice.toLocaleString()} on the way to the device · ${p.drops24h.fromDevice.toLocaleString()} coming from it · flow control ${p.fcTx || p.fcRx ? "on" : p.fcTx === false ? "off" : "unknown"}` : undefined}>{p.drops24h ? dropText(p.drops24h.toDevice + p.drops24h.fromDevice, p.drops24h.share) : "—"}</td>
                    {hasPoe && <td className="num dim">{p.poe ? `${p.poe.toFixed ? p.poe.toFixed(1) : p.poe} W` : "—"}</td>}
                    <td className={`num ${(p.rxErrors || 0) + (p.txErrors || 0) > 0 ? "warn" : "dim"}`}>{(p.rxErrors || 0) + (p.txErrors || 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        <History key={node.mac} mac={node.mac} />
      </aside>
    );
  }
  return null;
}

// The map, redesigned (UU-C-219): the internet line on top, then one card per gateway, switch and
// access point, from the gateway outward. A card says what it hangs off ("via Office switch ·
// port 3") instead of nesting, an access point lists its devices by band, a switch shows its
// ports as tiles with the devices on each port below. Problems are counted on the card.
function portSpeed(node, idx) {
  const p = (node.ports || []).find((x) => x.idx === idx);
  return p?.up && p.speed ? speed(p.speed) : null;
}
// What went through the port in the last 15 minutes (UU-C-233), local traffic included.
function portMoved(node, idx) {
  const p = (node.ports || []).find((x) => x.idx === idx);
  const n = p && p.toDevice15m != null ? p.toDevice15m + p.fromDevice15m : 0;
  return n > 0 ? bytes(n) : null;
}
const isGw = (n) => /udm|ugw|uxg/.test(n.type || "");
const isApN = (n) => /uap/.test(n.type || "");
const trouble = (c) => c.health === "warn";

// One device on a card: health, name, then band and signal or link speed, and traffic.
function ClientRow({ c, sel, selC, guest = false }) {
  const [open, setOpen] = useState(false);
  const at = useContext(AtCtx);
  const gs = c.guests || [];
  const wifi = !c.wired;
  const tip = `${c.name} · ${bytes(c.bytes15m)} in 15 min${splitTip(c.down15m, c.up15m)}${c.note ? ` · probably here: ${c.note}` : ""}${c.placed ? ` · last seen here ${ago(c.placed.ts)} — UniFi now only knows it is ${c.placed.nowAt}` : ""}`;
  return (
    <>
      <div className={`crow ${sel ? "sel" : ""} ${guest ? "guest" : ""}`}>
        <a className="crow-main" href={mapHref(at, { c: c.mac })} title={tip}>
          <span className={`status-dot ${healthClass(c.health)}`} />
          <span className="crow-name">{c.name}</span>
          {c.placed && <span className="dim small" title="Last seen on this port">↺</span>}
          {guest && c.kind && <span className="small dim">{KIND[c.kind]}{c.how === "presence" ? "?" : ""}</span>}
          <span className="crow-meta mono small">
            {c.bytes15m > 0 && <span className="dim">{bytes(c.bytes15m)}</span>}
            {wifi ? (
              <span className={c.signal != null && c.signal < -75 ? "warn" : ""}>{c.signal != null ? `${c.signal} dBm` : "—"}</span>
            ) : (
              c.speed != null && <span className={c.speed <= 100 && !c.usualSpeed ? "warn" : "dim"} title={c.usualSpeed ? "Its usual speed: it never linked faster in 30 days" : undefined}>{speed(c.speed)}</span>
            )}
          </span>
        </a>
      </div>
      {gs.length > 0 && (
        <button className={`crow-guests small ${open ? "on" : ""}`} onClick={() => setOpen((v) => !v)} aria-expanded={open} title="Virtual machines and containers on this device">
          {open ? "▾" : "▸"} {guestCount(gs)}
        </button>
      )}
      {open && <div className="crow-guestlist">{gs.map((g) => <ClientRow key={g.mac} c={g} sel={selC === g.mac} selC={selC} guest />)}</div>}
    </>
  );
}

// A switch's or gateway's ports as tiles: up, down, slow, and what is on each.
function PortStrip({ node, onPort }) {
  if (!node.ports?.length) return null;
  return (
    <div className="portstrip" role="list" aria-label={`${node.name} ports`}>
      {node.ports.map((p) => {
        const on = onPort.get(p.idx);
        const what = on ? [...on.kids.map((k) => k.name), ...on.clients.map((c) => c.name)] : [];
        const isUp = node.uplink?.port === p.idx && !isGw(node);
        const cls = !p.up ? "down" : p.speed && p.speed <= 100 && !p.usualSpeed ? "slow" : "up";
        return (
          <span key={p.idx} role="listitem" className={`port-tile ${cls} ${on?.kids.length ? "link" : ""}`} title={`Port ${p.idx}${p.name && p.name !== `Port ${p.idx}` ? ` (${p.name})` : ""} · ${p.up ? speed(p.speed) : "down"}${isUp ? " · uplink" : ""}${what.length ? ` · ${what.join(", ")}` : ""}`}>
            {p.idx}
            {isUp && <i aria-hidden="true">↑</i>}
          </span>
        );
      })}
    </div>
  );
}

function NodeCard({ node, parent, kids, sel, selC }) {
  const at = useContext(AtCtx);
  const ap = isApN(node);
  const wired = node.clients.filter((c) => c.wired);
  const wifi = node.clients.filter((c) => !c.wired);
  const weak = wifi.filter(trouble).length;
  const slow = wired.filter(trouble).length;
  // Ports: child equipment and wired devices on each.
  const onPort = new Map();
  const slot = (p) => {
    const k = p ?? "?";
    if (!onPort.has(k)) onPort.set(k, { kids: [], clients: [] });
    return onPort.get(k);
  };
  for (const k of kids) slot(k.uplink?.port).kids.push(k);
  for (const c of wired) slot(c.port).clients.push(c);
  const portOrder = [...onPort.keys()].sort((a, b) => (a === "?" ? 1 : b === "?" ? -1 : a - b));
  // Wi-Fi devices by band, in the radios' order.
  const bands = new Map();
  for (const r of node.radios || []) if (BAND[r.radio] && !bands.has(BAND[r.radio])) bands.set(BAND[r.radio], []);
  for (const c of wifi) {
    const b = BAND[c.radio] || "Wi-Fi";
    if (!bands.has(b)) bands.set(b, []);
    bands.get(b).push(c);
  }
  // CPU, temperature (where the device has a sensor) and uptime, on every card (UU-C-221).
  // Firmware too (UU-C-229): a gateway's firmware is its UniFi OS.
  const health = [node.cpu != null ? `CPU ${Math.round(node.cpu)}%` : null, node.temp != null ? `${Math.round(node.temp)} °C` : null, node.uptime != null ? `up ${duration(node.uptime)}` : null, node.firmware ? `${isGw(node) ? "OS" : "fw"} ${node.firmware}` : null].filter(Boolean).join(" · ");
  const stat = isGw(node)
    ? null
    : ap
      ? `${wifi.length} on Wi-Fi · ${Math.max(0, ...node.radios.map((r) => r.util || 0))}% busy`
      : `${(node.ports || []).filter((p) => p.up).length}/${(node.ports || []).length} ports up`;
  return (
    <section id={`node-${node.mac}`} className={`eq-card ${isGw(node) ? "gw" : ""} ${sel === node.mac ? "sel" : ""} ${node.online === false ? "offline" : ""}`}>
      <a className="eq-head" href={mapHref(at, { n: node.mac })}>
        <span className="eq-kind small">{kindOf(node.type)}{node.online === false ? " · offline" : ""}</span>
        <strong className="eq-name">{node.name}</strong>
        {stat && <span className="mono small dim">{stat}</span>}
        {health && <span className={`mono small dim ${node.temp >= 80 || node.cpu >= 90 ? "warn" : ""}`}>{health}</span>}
        {(node.upgradable || node.eol) && <span className={`small ${node.eol ? "warn" : "ok"}`}>{node.eol ? "End of life: no more firmware" : `Firmware update available${node.upgradeTo ? `: ${node.upgradeTo}` : ""}`}</span>}
        {node.overheating && <span className="eq-issues hot small">overheating</span>}
        {!node.overheating && (weak > 0 || slow > 0) && <span className="eq-issues small">{[weak ? `${weak} weak signal` : null, slow ? `${slow} slow link` : null].filter(Boolean).join(" · ")}</span>}
      </a>
      {parent && (
        <span className="eq-via small dim">
          via <a href={`#node-${parent.mac}`} onClick={(e) => { e.preventDefault(); document.getElementById(`node-${parent.mac}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>{parent.name}</a>
          {node.uplink?.port != null ? ` · port ${node.uplink.port}` : ""}
          {node.uplink?.speed ? ` · ${speed(node.uplink.speed)}` : ""}
          {node.uplink?.wireless ? " · wireless" : ""}
        </span>
      )}
      {ap && node.radios.length > 0 && (
        <div className="eq-radios small">
          {node.radios.map((r) => (
            <span key={r.radio} className="mono" title={`${r.clients ?? 0} clients`}>
              {BAND[r.radio] || r.radio} · ch {r.channel}{r.width ? ` · ${r.width}` : ""} · <span className={(r.util || 0) >= 70 ? "warn" : ""}>{r.util ?? 0}%</span>
            </span>
          ))}
        </div>
      )}
      <PortStrip node={node} onPort={onPort} />
      {portOrder.length > 0 && (
        <div className="eq-group">
          {portOrder.map((p) => {
            const g = onPort.get(p);
            const sp = p === "?" ? null : portSpeed(node, p);
            const mv = p === "?" ? null : portMoved(node, p);
            return (
              <div key={p} className="eq-port">
                <span className="eq-port-label small dim" title={mv ? "Through this port in the last 15 minutes, local traffic included" : undefined}>{p === "?" ? "Port unknown" : `Port ${p}`}{sp ? ` · ${sp}` : ""}{mv ? ` · ${mv}` : ""}</span>
                {g.kids.map((k) => (
                  <a key={k.mac} className="crow crow-eq" href={`#node-${k.mac}`} onClick={(e) => { e.preventDefault(); document.getElementById(`node-${k.mac}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>
                    <span className={`status-dot ${k.online === false ? "off" : ""}`} />
                    <span className="crow-name">{k.name}</span>
                    <span className="crow-meta small dim">{kindOf(k.type).toLowerCase()} ↓</span>
                  </a>
                ))}
                {g.clients.map((c) => <ClientRow key={c.mac} c={c} sel={selC === c.mac} selC={selC} />)}
              </div>
            );
          })}
        </div>
      )}
      {wifi.length > 0 && (
        <div className="eq-group">
          {[...bands.entries()].filter(([, list]) => list.length).map(([b, list]) => (
            <div key={b} className="eq-port">
              <span className="eq-port-label small dim">{b} · {list.length}</span>
              {list.map((c) => <ClientRow key={c.mac} c={c} sel={selC === c.mac} selC={selC} />)}
            </div>
          ))}
        </div>
      )}
      {!node.clients.length && !kids.length && <span className="small dim">Nothing connected.</span>}
    </section>
  );
}

function NetBar({ data, sel }) {
  const at = useContext(AtCtx);
  const w = data.wan;
  const link = data.gateway?.uplink?.speed;
  const ok = w?.status === "ok";
  return (
    <a className={`netbar ${sel === "internet" ? "sel" : ""}`} href={mapHref(at, { n: "internet" })}>
      <span className="netbar-item">
        <span className="small dim">Internet</span>
        <strong>{w?.isp || "WAN"}</strong>
      </span>
      <span className="netbar-item">
        <span className="small dim">Status</span>
        <span className={`mono ${ok ? "ok" : "warn"}`}>{ok ? "OK" : w?.status || "unknown"}{w?.latency != null ? ` · ${w.latency} ms` : ""}</span>
      </span>
      {w?.ip && (
        <span className="netbar-item">
          <span className="small dim">Public IP</span>
          <span className="mono">{w.ip}</span>
        </span>
      )}
      {wanNow(w, link) && (
        <span className="netbar-item">
          <span className="small dim">Right now</span>
          <span className="mono">{wanNow(w, link)}</span>
        </span>
      )}
      {w?.availability != null && (
        <span className="netbar-item" title="UniFi's internet check: the share of its pings answered since the gateway last started">
          <span className="small dim">Reachable</span>
          <span className="mono">{+Number(w.availability).toFixed(2)}%</span>
        </span>
      )}
    </a>
  );
}

function NetMap({ data, sel, selC }) {
  const gateway = data.gateway;
  if (!gateway) return <div className="card empty">No gateway data yet.</div>;
  const all = [gateway, ...data.nodes];
  const byName = Object.fromEntries(all.map((n) => [n.name, n]));
  const parentOf = (n) => (n === gateway ? null : (n.uplink?.device && byName[n.uplink.device]) || gateway);
  const kidsOf = (n) => all.filter((k) => k !== n && parentOf(k) === n).sort((a, b) => (a.uplink?.port ?? 99) - (b.uplink?.port ?? 99));
  // From the gateway outward, so a card's parent always comes first.
  const order = [];
  const seen = new Set();
  const walk = (n) => {
    if (seen.has(n)) return;
    seen.add(n);
    order.push(n);
    for (const k of kidsOf(n)) walk(k);
  };
  walk(gateway);
  for (const n of all) walk(n);
  return (
    <div className="netmap">
      <NetBar data={data} sel={sel} />
      <div className="eq-grid">
        {order.map((n) => <NodeCard key={n.mac} node={n} parent={parentOf(n)} kids={kidsOf(n)} sel={sel} selC={selC} />)}
        {data.loose.length > 0 && (
          <section className="eq-card">
            <div className="eq-head static">
              <span className="eq-kind small">Elsewhere</span>
              <strong className="eq-name">Behind other devices</strong>
              <span className="small dim">UniFi cannot place these on a port or access point</span>
            </div>
            <div className="eq-group"><div className="eq-port">{data.loose.map((c) => <ClientRow key={c.mac} c={c} sel={selC === c.mac} selC={selC} />)}</div></div>
          </section>
        )}
      </div>
    </div>
  );
}

// One line under the title: how many devices, and how many need a look.
function Summary({ data }) {
  const flat = [...[data.gateway, ...data.nodes].filter(Boolean).flatMap((n) => n.clients), ...data.loose];
  const wifi = flat.filter((c) => !c.wired).length;
  const weak = flat.filter((c) => !c.wired && c.health === "warn").length;
  const slow = flat.filter((c) => c.wired && c.health === "warn").length;
  const offline = [data.gateway, ...data.nodes].filter((n) => n && n.online === false).length;
  return (
    <div className="net-summary small">
      <span><strong>{flat.length}</strong> devices</span>
      <span>{wifi} Wi-Fi · {flat.length - wifi} wired</span>
      {weak > 0 && <span className="warn">{weak} weak signal</span>}
      {slow > 0 && <span className="warn">{slow} slow link</span>}
      {offline > 0 && <span className="bad">{offline} equipment offline</span>}
      {!weak && !slow && !offline && <span className="ok">all healthy</span>}
    </div>
  );
}

// Pick the moment the map shows (UU-C-213): Live, or a day and time within the 90 days of
// samples, stepped by 5 minutes or an hour. Times are this browser's clock.
const pad = (n) => String(n).padStart(2, "0");
const dateOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function TimeBar({ at, route }) {
  const now = Date.now();
  const set = (t) => go("network", null, { ...route.query, at: t == null || t >= now - 60e3 ? null : Math.round(t) });
  const cur = new Date(at ?? now);
  const dateVal = dateOf(cur);
  const timeVal = `${pad(cur.getHours())}:${pad(cur.getMinutes())}`;
  const pick = (dv, tv) => {
    const t = new Date(`${dv}T${tv || "00:00"}`).getTime();
    if (Number.isFinite(t)) set(Math.max(now - 90 * 86400e3, Math.min(t, now)));
  };
  const step = (ms) => set((at ?? now) + ms);
  return (
    <div className="timebar" role="group" aria-label="Time the map shows">
      <button className={`btn quiet ${at == null ? "on" : ""}`} aria-pressed={at == null} onClick={() => set(null)}>Live</button>
      <button className="btn quiet" onClick={() => step(-3600e3)} title="One hour earlier">‹ 1 h</button>
      <button className="btn quiet" onClick={() => step(-300e3)} title="Five minutes earlier">‹ 5 min</button>
      <input type="date" value={dateVal} min={dateOf(new Date(now - 90 * 86400e3))} max={dateOf(new Date(now))} onChange={(e) => e.target.value && pick(e.target.value, timeVal)} aria-label="Day" />
      <input type="time" step="300" value={timeVal} onChange={(e) => e.target.value && pick(dateVal, e.target.value)} aria-label="Time" />
      <button className="btn quiet" disabled={at == null} onClick={() => step(300e3)} title="Five minutes later">5 min ›</button>
      <button className="btn quiet" disabled={at == null} onClick={() => step(3600e3)} title="One hour later">1 h ›</button>
    </div>
  );
}

// The whole network over time (UU-C-213): the internet line, devices online and every change
// on the equipment. A bar or a time opens the map as it was then.
function NetworkTimeline({ route }) {
  const [days, setDays] = useState(1);
  const { data, error, loading, reload } = useApi(`/api/network/timeline?days=${days}`);
  const when = (t) => (days === 1 ? clock(t) : shortDate(t));
  const jump = (t) => go("network", null, { ...route.query, c: null, v: null, at: Math.min(Date.now() - 61e3, Math.round(t)) });
  const sum = data?.summary;
  const row = (label, note, items) => (
    <div className="history-radio">
      <div className="kv"><div><span>{label}</span><span className="mono small dim">{note}</span></div></div>
      <Bars short items={items} />
    </div>
  );
  return (
    <section className="card net-timeline">
      <div className="card-head">
        <h2>Network history</h2>
        <div className="history-range end" role="group" aria-label="History period">
          {HISTORY_DAYS.map(([d, label]) => (
            <button key={d} className={`btn quiet ${days === d ? "on" : ""}`} aria-pressed={days === d} onClick={() => setDays(d)}>{label}</button>
          ))}
        </div>
      </div>
      {error && <Failed error={error} reload={reload} />}
      {!data && loading && <Loading />}
      {data && !data.samples && <p className="dim small" style={{ margin: 0 }}>Nothing recorded in this period.</p>}
      {data?.samples > 0 && (
        <>
          <div className="kv">
            <div><span>Internet latency</span><span className="mono">{sum.latency != null ? `${sum.latency} ms average` : "—"}</span></div>
            <div><span>Busiest internet moment</span><span className="mono">{sum.downPeak != null ? `↓ ${sum.downPeak} Mbps · ↑ ${sum.upPeak} Mbps` : "—"}</span></div>
            <div><span>Most devices on</span><span className="mono">{sum.devicesPeak ?? "—"}</span></div>
            <div><span>Internet outages</span><span className={`mono ${sum.outages ? "bad" : ""}`}>{sum.outages}</span></div>
          </div>
          {row("Internet down", "average Mbps per bar", data.series.map((p) => ({
            value: p.down || 0,
            nodata: p.down == null,
            tip: p.down == null ? `${when(p.t)}: nothing recorded` : `${when(p.t)}: ↓ ${p.down} Mbps average, ${p.downPeak} peak · ↑ ${p.up} Mbps${p.outage ? " · internet trouble" : ""}`,
            onClick: () => jump(p.t + data.step),
          })))}
          {row("Latency", "ms", data.series.map((p) => ({
            value: p.latency || 0,
            nodata: p.latency == null,
            tip: p.latency == null ? `${when(p.t)}: nothing recorded` : `${when(p.t)}: ${p.latency} ms`,
            onClick: () => jump(p.t + data.step),
          })))}
          {row("Devices on", "Wi-Fi + wired", data.series.map((p) => ({
            value: p.devices || 0,
            nodata: p.devices == null,
            tip: p.devices == null ? `${when(p.t)}: nothing recorded` : `${when(p.t)}: ${p.devices} devices (${p.wifi} Wi-Fi, ${p.wired} wired)`,
            onClick: () => jump(p.t + data.step),
          })))}
          {data.events.length > 0 ? (
            <div className="kv net-events">
              {data.events.map((e, i) => (
                <div key={`${e.ts}-${i}`}>
                  <button className="linkish small dim" onClick={() => jump(e.ts)} title="Show the map at this time">{when(e.ts)}</button>
                  <span className={EVENT_CLASS[e.level] || ""} style={{ textAlign: "right" }}>
                    <span className="dim">{e.who} · </span>{e.what}{e.detail ? <span className="dim small"> · {e.detail}</span> : null}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="dim small" style={{ margin: 0 }}>No restarts, outages, channel or port changes and no new devices in this period.</p>
          )}
          {data.moreEvents > 0 && <p className="dim small" style={{ margin: 0 }}>{data.moreEvents} earlier changes not listed.</p>}
          <p className="dim small" style={{ margin: 0 }}>Click a bar or a time to open the map as it was then. Recorded with every update, kept 90 days.</p>
        </>
      )}
    </section>
  );
}

export default function Network({ route }) {
  const at = Number(route.query.at) > 0 ? Number(route.query.at) : null;
  const { data, error, loading, reload } = useApi(at ? `/api/network?at=${at}` : "/api/network", at ? 0 : 60 * 1000);
  const empty = at && data && !data.gateway && !data.nodes?.length && !data.loose?.length;
  const sel = route.query.n || null;
  const selC = route.query.c || null;
  // Map or History (UU-C-219): the history was a card far below the map.
  const view = route.query.v === "history" ? "history" : "map";
  const setView = (v) => go("network", null, { ...route.query, v: v === "map" ? null : v });
  // Closing the panel (UU-C-225): a click on empty space beside it, Escape, or its ×.
  const picked = Boolean(sel || selC);
  const closeHref = href("network", null, { ...route.query, n: null, c: null });
  const onMainClick = (e) => {
    if (!picked || e.button !== 0 || e.target.closest("a, button, input, select, textarea, label, summary, [role=button], [role=tab]")) return;
    if (String(window.getSelection?.() || "")) return; // finishing a text selection is not a click away
    window.location.hash = closeHref;
  };
  useEffect(() => {
    if (!picked) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape" && !e.target.closest?.("input, select, textarea")) window.location.hash = closeHref;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picked, closeHref]);
  return (
    <div className="split">
      <div className="main" onClick={onMainClick}>
        <div className="page wide">
          <div className="page-head">
            <div className="titles">
              <span className={`small ${at ? "warn" : "dim"}`}>{at ? `Network · as it was ${shortDate(at)}` : "Network · live, refreshes every minute"}</span>
              <h1>Your network</h1>
            </div>
            <div className="seg net-views" role="tablist" aria-label="Network view">
              <button role="tab" aria-selected={view === "map"} className={view === "map" ? "on" : ""} onClick={() => setView("map")}>Map</button>
              <button role="tab" aria-selected={view === "history"} className={view === "history" ? "on" : ""} onClick={() => setView("history")}>History</button>
            </div>
          </div>
          {view === "map" && (
            <>
              <div className="net-toolbar">
                {data && !empty ? <Summary data={data} /> : <span />}
                <TimeBar at={at} route={route} />
              </div>
              {error && <Failed error={error} reload={reload} />}
              {!data && loading && <Loading />}
              {empty && <div className="card empty">Nothing was recorded at that time: NetLens was not running, or it is before the 90 days it keeps.</div>}
              <AtCtx.Provider value={at}>
                {data && !empty && <NetMap data={data} sel={sel} selC={selC} />}
              </AtCtx.Provider>
            </>
          )}
          {view === "history" && <NetworkTimeline route={route} />}
        </div>
      </div>
      <AtCtx.Provider value={at}>{data && <Panel data={data} route={route} closeHref={closeHref} />}</AtCtx.Provider>
    </div>
  );
}
