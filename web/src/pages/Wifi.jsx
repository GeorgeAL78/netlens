import { useMemo, useState } from "react";
import { ago, clock, go, href, shortDate, useApi } from "../lib.js";
import { Failed, Loading } from "../ui.jsx";

// Wi-Fi (UU-C-239): each access point's radios (channel, how busy, how much of that is other
// networks), the nearby networks that share their channels — sifted from the hundreds UniFi
// hears — and every Wi-Fi device's signal, band, roams and failed joins.

const DAYS = [[1, "24 hours"], [7, "7 days"], [30, "30 days"]];
const BAND_LABEL = { "2.4": "2.4 GHz", 5: "5 GHz", 6: "6 GHz" };
const pct = (v) => (v == null ? "—" : `${Math.round(v)}%`);
const busyClass = (v) => (v == null ? "dim" : v >= 70 ? "bad" : v >= 50 ? "warn" : "");
const sigClass = (s) => (s == null ? "dim" : s >= -67 ? "" : s >= -75 ? "" : s >= -80 ? "warn" : "bad");
const PAGE = 40;
// Hidden radios have no name to group by, so they are grouped per channel (UU-C-241).
const netName = (g) => (
  <>
    {g.name || <span className="dim">{g.radios > 1 ? "Hidden networks" : "Hidden network"}</span>}
    {g.radios > 1 && <span className="dim small"> · {g.radios} radios</span>}
    {/^DIRECT-/i.test(g.name || "") && <span className="dim small" title="Wi-Fi Direct: a printer, TV or car showing its own network"> · device</span>}
  </>
);

function AccessPoints({ aps }) {
  if (!aps.length) return <div className="card empty">No access points recorded in this period.</div>;
  return (
    <section className="card">
      <div className="card-head">
        <h2>Access points</h2>
        <span className="hint">Busy: how much of the time the channel was in use. Other networks: the part taken by neighbours and noise.</span>
      </div>
      {aps.map((a) => (
        <div key={a.mac} className="wifi-ap">
          <div className="wifi-ap-head">
            <a href={href("network", null, { n: a.mac })}><strong>{a.name}</strong></a>
            <span className="dim small">{a.model}</span>
            {!a.online && <span className="tag warn">OFFLINE</span>}
            {a.day && (
              <span className="small muted wifi-ap-day" title="Network 11's statistics engine, last 24 hours">
                {a.day.retryPct != null && <span className={a.day.retryPct >= 15 ? "warn" : ""}>{a.day.retryPct}% sent again</span>}
                {a.day.satisfaction != null && <span>experience {Math.round(a.day.satisfaction)}%</span>}
                {a.day.signal != null && <span>devices at {Math.round(a.day.signal)} dBm on average</span>}
              </span>
            )}
          </div>
          <div className="scroll-x">
            <table className="t">
              <thead>
                <tr>
                  <th>Band</th>
                  <th className="num">Channel</th>
                  <th className="num">Width</th>
                  <th className="num">Power</th>
                  <th className="num">Devices</th>
                  <th className="num">Busy now</th>
                  <th className="num" title="Airtime used by other networks and noise">Other networks</th>
                  <th className="num">Busy avg · peak</th>
                </tr>
              </thead>
              <tbody>
                {a.radios.map((r) => (
                  <tr key={r.radio}>
                    <td>{r.band}</td>
                    <td className="num mono">{r.channel ?? "—"}</td>
                    <td className="num mono dim">{r.width ? `${r.width} MHz` : "—"}</td>
                    <td className="num mono dim">{r.txPower != null ? `${r.txPower} dBm` : "—"}</td>
                    <td className="num mono">{r.clients ?? "—"}</td>
                    <td className={`num mono ${busyClass(r.util)}`}>{pct(r.util)}</td>
                    <td className={`num mono ${busyClass(r.interf)}`}>{pct(r.interf)}</td>
                    <td className="num mono dim">{r.avgUtil != null ? `${pct(r.avgUtil)} · ${pct(r.peakUtil)}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </section>
  );
}

// One band's channels with the loud neighbours heard on each; ours marked. No advice here: an
// access point hears its own channel best, so a channel none of ours uses looks emptier than it
// is (UU-C-241). Advice comes from UniFi's RF scans (ChannelAdvice).
const isDfs = (band, ch) => band === "5" && ch >= 52 && ch <= 144;
function Channels({ band }) {
  return (
    <div className="wifi-channels">
      <h3>{BAND_LABEL[band.band]} {band.band !== "2.4" ? <span className="dim small">· {band.width} MHz blocks</span> : null}</h3>
      <div className="scroll-x">
        <table className="t">
          <thead>
            <tr>
              <th className="num">Channel</th>
              <th className="num">Loud networks</th>
              <th className="num">Loudest</th>
              <th>Yours</th>
            </tr>
          </thead>
          <tbody>
            {band.rows.map((r) => (
              <tr key={r.channel} className={r.ours.length ? "wifi-mine" : ""}>
                <td className="num mono">{band.band === "2.4" ? r.channel : `${r.channel}${band.width > 20 ? `–${r.channel + (band.width / 5 - 4)}` : ""}`}{isDfs(band.band, r.channel) ? <span className="dim small" title="Radar channels (DFS): an access point must leave them when it hears radar"> DFS</span> : null}</td>
                <td className={`num mono ${r.ours.length ? "" : "dim"}`}>{r.networks}</td>
                <td className={`num mono ${sigClass(r.loudest)}`}>{r.loudest != null ? `${r.loudest} dBm` : "—"}</td>
                <td className="small">{r.ours.join(", ") || <span className="dim">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Channel suggestions from UniFi's RF scans, kept by NetLens over 30 days (UU-C-241).
function ChannelAdvice({ advice }) {
  const [open, setOpen] = useState(false);
  if (!advice?.length) return null;
  const scanned = advice.filter((a) => a.scans > 0);
  const moves = scanned.filter((a) => a.suggest);
  const nScans = Math.max(0, ...scanned.map((a) => a.scans));
  const since = Math.min(...scanned.map((a) => a.firstAt));
  return (
    <section className="card">
      <div className="card-head">
        <h2>Channel suggestions</h2>
        <span className="hint">
          {scanned.length ? `From ${nScans} UniFi RF scan${nScans === 1 ? "" : "s"} per access point since ${shortDate(since)}. UniFi scans at night; daytime can differ, so the radio's own busy share over the period is shown too.` : "No RF scan from UniFi yet."}
        </span>
      </div>
      {!scanned.length && <p className="small muted" style={{ margin: 0 }}>UniFi runs an RF scan at night, or you can run one from an access point's page in UniFi (its devices drop for a minute). NetLens keeps every scan it sees and suggests channels from them.</p>}
      {scanned.length > 0 && (
        <>
          <div className="scroll-x">
            <table className="t">
              <thead>
                <tr>
                  <th>Access point</th>
                  <th>Band</th>
                  <th className="num">Channel</th>
                  <th className="num" title="Average utilization of this channel in UniFi's RF scans">Scans: busy</th>
                  <th className="num" title="This radio's own busy share over the period shown">Daytime busy</th>
                  <th>Suggestion</th>
                </tr>
              </thead>
              <tbody>
                {advice.map((a) => (
                  <tr key={`${a.mac}|${a.radio}`}>
                    <td>{a.ap}</td>
                    <td className="small">{BAND_LABEL[a.band]}</td>
                    <td className="num mono">{a.channel ?? "—"}</td>
                    <td className="num mono">{a.current?.util != null ? pct(a.current.util) : "—"}</td>
                    <td className={`num mono ${busyClass(a.daytime)}`}>{pct(a.daytime)}</td>
                    <td className="small">
                      {!a.scans ? <span className="dim">no scan yet</span> : a.suggest ? <span className="warn">Move to channel {a.suggest.channel} ({pct(a.suggest.util)} busy in scans)</span> : <span className="ok">Keep: no free channel is clearly quieter</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            {moves.length ? "A move is suggested only when another channel was at least 10 points quieter on average, no other access point of yours uses it, and (on 5 GHz) it is not a radar channel. Change it in UniFi under the access point's Settings › Radios; NetLens never changes it." : "Your channels are about as quiet as any free one in UniFi's scans."}{" "}
            {nScans < 3 ? "With fewer than 3 scans this is a first look; it firms up night by night." : ""}
          </p>
          <button className="btn quiet small" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "Hide" : "Show"} every channel in the scans</button>
          {open && (
            <div className="wifi-channel-grid">
              {scanned.map((a) => (
                <div key={`${a.mac}|${a.radio}`} className="wifi-channels">
                  <h3>{a.ap} <span className="dim small">· {BAND_LABEL[a.band]}</span></h3>
                  <table className="t">
                    <thead><tr><th className="num">Channel</th><th className="num">Busy in scans</th><th>Note</th></tr></thead>
                    <tbody>
                      {a.options.map((o) => (
                        <tr key={o.channel} className={o.current ? "wifi-mine" : ""}>
                          <td className="num mono">{o.channel}{o.width > 20 ? <span className="dim small"> · {o.width} MHz</span> : null}</td>
                          <td className={`num mono ${busyClass(o.util)}`}>{pct(o.util)}</td>
                          <td className="small dim">{[o.current ? "this radio" : null, o.usedBy.length ? `used by ${o.usedBy.join(", ")}` : null, o.dfs ? "radar (DFS)" : null].filter(Boolean).join(" · ") || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function NetRow({ g }) {
  return (
    <tr>
      <td>{netName(g)}</td>
      <td className="small">{BAND_LABEL[g.band]}</td>
      <td className="num mono">{g.channels.join(", ") || "—"}{g.width ? <span className="dim small"> · {g.width} MHz</span> : null}</td>
      <td className={`num mono ${sigClass(g.signal)}`}>{g.signal != null ? `${g.signal} dBm` : "—"}</td>
      <td className="small dim">{g.security || "—"}</td>
      <td className="small dim">{g.heardBy.join(", ") || "—"}{g.lastSeen ? ` · ${ago(g.lastSeen)}` : ""}</td>
    </tr>
  );
}

function Nearby({ n }) {
  const [text, setText] = useState("");
  const [band, setBand] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [allCompeting, setAllCompeting] = useState(false);
  const list = useMemo(() => {
    const t = text.trim().toLowerCase();
    return n.all.filter((g) => (!band || g.band === band) && (!t || String(g.name || "hidden").toLowerCase().includes(t) || g.channels.some((c) => String(c) === t)));
  }, [n.all, text, band]);
  if (!n.at) return <section className="card"><h2>Nearby networks</h2><p className="dim small" style={{ margin: 0 }}>Not read from UniFi yet; NetLens reads them once an hour.</p></section>;
  return (
    <section className="card">
      <div className="card-head">
        <h2>Nearby networks</h2>
        <span className="hint">Read {ago(n.at)}</span>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        Your access points heard {n.heard.toLocaleString()} radios in the last 24 hours: {n.networks.toLocaleString()} networks, {n.strong} of them loud enough to matter (above {n.threshold} dBm). Only those can slow your Wi-Fi, and only on a channel you use.
      </p>
      <h3>Sharing your channels</h3>
      {n.competing.length ? (
        <div className="scroll-x">
          <table className="t">
            <thead>
              <tr>
                <th>Network</th>
                <th>Band</th>
                <th className="num">Channel</th>
                <th className="num">Signal</th>
                <th>Shares air with</th>
                <th>Last heard</th>
              </tr>
            </thead>
            <tbody>
              {(allCompeting ? n.competing : n.competing.slice(0, 10)).map((g) => (
                <tr key={`${g.name}|${g.band}|${g.channels.join(",")}`}>
                  <td>{netName(g)}</td>
                  <td className="small">{BAND_LABEL[g.band]}</td>
                  <td className="num mono">{g.channels.join(", ")}</td>
                  <td className={`num mono ${sigClass(g.signal)}`}>{g.signal} dBm</td>
                  <td className="small">{g.competes.join(", ")}</td>
                  <td className="small dim">{g.lastSeen ? ago(g.lastSeen) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="small ok" style={{ margin: 0 }}>No loud network shares a channel with your access points.</p>
      )}
      {!allCompeting && n.competing.length > 10 && <button className="btn quiet small" onClick={() => setAllCompeting(true)}>Show all {n.competing.length}, loudest first</button>}
      {n.channels.length > 0 && (
        <>
          <h3>Channels around you</h3>
          <p className="small muted" style={{ margin: 0 }}>Loud networks heard on each channel. Your access points hear their own channels best, so a channel none of them uses can look emptier than it is: use the channel suggestions on Access points, which come from UniFi's scans of every channel.</p>
          <div className="wifi-channel-grid">{n.channels.map((b) => <Channels key={b.band} band={b} />)}</div>
        </>
      )}
      <details className="wifi-all">
        <summary>All {n.networks.toLocaleString()} networks</summary>
        <div className="card-head" style={{ gap: 10, flexWrap: "wrap", marginTop: 8 }}>
          <input className="field" style={{ minWidth: 220 }} placeholder="Search name or channel" aria-label="Search nearby networks" value={text} onChange={(e) => { setText(e.target.value); setShown(PAGE); }} />
          <div className="seg" role="group" aria-label="Band">
            {[["", "All"], ["2.4", "2.4 GHz"], ["5", "5 GHz"], ["6", "6 GHz"]].map(([id, label]) => (
              <button key={id} className={band === id ? "on" : ""} onClick={() => { setBand(id); setShown(PAGE); }}>{label}</button>
            ))}
          </div>
          <span className="small dim">{list.length.toLocaleString()} shown, loudest first</span>
        </div>
        <div className="scroll-x">
          <table className="t">
            <thead>
              <tr>
                <th>Network</th>
                <th>Band</th>
                <th className="num">Channel</th>
                <th className="num">Signal</th>
                <th>Security</th>
                <th>Heard by</th>
              </tr>
            </thead>
            <tbody>{list.slice(0, shown).map((g) => <NetRow key={`${g.name}|${g.band}|${g.channels.join(",")}`} g={g} />)}</tbody>
          </table>
        </div>
        {list.length > shown && <button className="btn quiet small" onClick={() => setShown(shown + PAGE * 2)}>Show more ({(list.length - shown).toLocaleString()} left)</button>}
      </details>
    </section>
  );
}

function Devices({ devices, days }) {
  const [all, setAll] = useState(false);
  const slower = devices.filter((d) => d.fasterSeen);
  const list = all ? devices : devices.slice(0, 25);
  return (
    <section className="card">
      <div className="card-head">
        <h2>Wi-Fi devices</h2>
        <span className="hint">Weakest first. Weak: below −80 dBm, where pages start to stall.</span>
      </div>
      {slower.length > 0 && (
        <p className="small muted" style={{ margin: 0 }}>
          On 2.4 GHz now, though they used 5 or 6 GHz in the last 30 days: {slower.map((d) => d.name).join(", ")}. Usually too far from an access point for the faster band; closer, or another access point, moves them back.
        </p>
      )}
      <div className="scroll-x">
        <table className="t">
          <thead>
            <tr>
              <th>Device</th>
              <th>Access point</th>
              <th>Band</th>
              <th className="num">Signal</th>
              <th className="num">Average</th>
              <th className="num">Time weak</th>
              <th className="num">Roams</th>
              <th className="num" title="Failed attempts to join Wi-Fi">Failed joins</th>
            </tr>
          </thead>
          <tbody>
            {list.map((d) => (
              <tr key={d.mac}>
                <td><a href={href("device", d.mac)}>{d.name}</a>{d.fasterSeen && <span className="tag warn" title={`On 5 or 6 GHz ${shortDate(d.fasterSeen)}`}>WAS ON 5 GHz</span>}</td>
                <td className="small">{d.ap || "—"}</td>
                <td className="small">{d.band || "—"}{d.channel ? <span className="dim"> · ch {d.channel}</span> : null}</td>
                <td className={`num mono ${sigClass(d.signal)}`}>{d.signal != null ? `${d.signal} dBm` : "—"}</td>
                <td className={`num mono ${sigClass(d.avgSignal)}`}>{d.avgSignal != null ? `${Math.round(d.avgSignal)} dBm` : "—"}</td>
                <td className={`num mono ${d.badShare >= 10 ? "warn" : "dim"}`}>{d.badShare != null ? `${d.badShare}%` : "—"}</td>
                <td className="num mono dim">{d.roams || 0}</td>
                <td className={`num mono ${d.failedJoins ? "warn" : "dim"}`}>{d.failedJoins || 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {devices.length > list.length && <button className="btn quiet small" onClick={() => setAll(true)}>Show all {devices.length}</button>}
      {!devices.length && <p className="dim small" style={{ margin: 0 }}>No Wi-Fi devices recorded in the last {days === 1 ? "24 hours" : `${days} days`}.</p>}
    </section>
  );
}

// Three tabs (UU-C-241): the radios with channel advice, the nearby networks, the devices.
const VIEWS = [
  ["aps", "Access points"],
  ["nearby", "Nearby networks"],
  ["devices", "Devices"],
];

export default function Wifi({ route }) {
  const view = VIEWS.some(([id]) => id === route.query.v) ? route.query.v : "aps";
  const [days, setDays] = useState(1);
  const { data, error, loading, reload } = useApi(`/api/wifi/summary?days=${days}`, 5 * 60 * 1000);
  const bands = data ? Object.entries(data.bandsNow || {}).sort((a, b) => parseFloat(a[0]) - parseFloat(b[0])).map(([b, n]) => `${n} on ${b}`).join(" · ") : "";
  return (
    <div className="page wide capped">
      <div className="page-head">
        <div className="titles">
          <span className="dim small">Network · Wi-Fi</span>
          <h1>Wi-Fi</h1>
          {data && <span className="muted">{bands || "No devices on Wi-Fi now"}{data.newest ? ` · as of ${clock(data.newest)}` : ""}</span>}
        </div>
        <div className="seg" role="tablist" aria-label="Wi-Fi view">
          {VIEWS.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={view === id} className={view === id ? "on" : ""} onClick={() => go("wifi", null, { ...route.query, v: id === "aps" ? null : id })}>
              {label}
              {id === "devices" && data ? <span className="dim"> {data.devices.length}</span> : null}
            </button>
          ))}
        </div>
        {view !== "nearby" && (
          <div className="seg" role="group" aria-label="Period">
            {DAYS.map(([d, label]) => (
              <button key={d} className={days === d ? "on" : ""} aria-pressed={days === d} onClick={() => setDays(d)}>{label}</button>
            ))}
          </div>
        )}
      </div>
      {error && <Failed error={error} reload={reload} />}
      {!data && loading && <Loading />}
      {data && view === "aps" && (
        <>
          <ChannelAdvice advice={data.advice} />
          <AccessPoints aps={data.aps} />
        </>
      )}
      {data && view === "nearby" && <Nearby n={data.nearby} />}
      {data && view === "devices" && <Devices devices={data.devices} days={days} />}
    </div>
  );
}
