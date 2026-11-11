import { useMemo, useState } from "react";
import { ago, clock, href, shortDate, useApi } from "../lib.js";
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

// One band's channels with the strong neighbours on each; ours marked, the quietest suggested.
const isDfs = (band, ch) => band === "5" && ch >= 52 && ch <= 144;
function Channels({ band }) {
  // Advice compares with the quietest channel any device can use: radar (DFS) channels can be
  // left at any moment, so an empty one is mentioned, not suggested.
  const plain = band.rows.filter((r) => !isDfs(band.band, r.channel));
  const quietest = Math.min(...(plain.length ? plain : band.rows).map((r) => r.networks));
  const radarQuieter = band.rows.some((r) => isDfs(band.band, r.channel) && r.networks < quietest);
  const mine = band.rows.filter((r) => r.ours.length);
  const better = mine.filter((r) => r.networks >= quietest + 3);
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
                <td className={`num mono ${r.networks <= quietest ? "ok" : r.networks >= quietest + 3 ? "warn" : ""}`}>{r.networks}</td>
                <td className={`num mono ${sigClass(r.loudest)}`}>{r.loudest != null ? `${r.loudest} dBm` : "—"}</td>
                <td className="small">{r.ours.join(", ") || <span className="dim">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {better.length > 0 && (
        <p className="small muted" style={{ margin: "6px 0 0" }}>
          {better.map((r) => r.ours.join(" and ")).join(", ")} {better.length === 1 && better[0].ours.length === 1 ? "is" : "are"} on a channel with {better[0].networks} loud neighbours; the quietest has {quietest}. UniFi's radio settings can move {better.length === 1 && better[0].ours.length === 1 ? "it" : "them"}, or let UniFi pick channels on its own.{radarQuieter ? " Radar (DFS) channels are quieter still where your access points are allowed to use them." : ""}
        </p>
      )}
    </div>
  );
}

function NetRow({ g }) {
  return (
    <tr>
      <td>{g.name || <span className="dim">Hidden network</span>}{g.radios > 1 && <span className="dim small"> · {g.radios} radios</span>}</td>
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
              </tr>
            </thead>
            <tbody>
              {(allCompeting ? n.competing : n.competing.slice(0, 10)).map((g) => (
                <tr key={`${g.name}|${g.band}`}>
                  <td>{g.name || <span className="dim">Hidden network</span>}{g.radios > 1 && <span className="dim small"> · {g.radios} radios</span>}</td>
                  <td className="small">{BAND_LABEL[g.band]}</td>
                  <td className="num mono">{g.channels.join(", ")}</td>
                  <td className={`num mono ${sigClass(g.signal)}`}>{g.signal} dBm</td>
                  <td className="small">{g.competes.join(", ")}</td>
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
          <p className="small muted" style={{ margin: 0 }}>Loud networks on each channel. Fewer is better; 6 GHz is left out because few neighbours use it yet.</p>
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
            <tbody>{list.slice(0, shown).map((g) => <NetRow key={`${g.name}|${g.band}`} g={g} />)}</tbody>
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

export default function Wifi({ route }) {
  const [days, setDays] = useState(1);
  const { data, error, loading, reload } = useApi(`/api/wifi/summary?days=${days}`, 5 * 60 * 1000);
  const bands = data ? Object.entries(data.bandsNow || {}).sort((a, b) => parseFloat(a[0]) - parseFloat(b[0])).map(([b, n]) => `${n} on ${b}`).join(" · ") : "";
  return (
    <div className="page wide">
      <div className="page-head">
        <div className="titles">
          <span className="dim small">Network · Wi-Fi</span>
          <h1>Wi-Fi</h1>
          {data && <span className="muted">{bands || "No devices on Wi-Fi now"}{data.newest ? ` · as of ${clock(data.newest)}` : ""}</span>}
        </div>
        <div className="seg" role="group" aria-label="Period">
          {DAYS.map(([d, label]) => (
            <button key={d} className={days === d ? "on" : ""} aria-pressed={days === d} onClick={() => setDays(d)}>{label}</button>
          ))}
        </div>
      </div>
      {error && <Failed error={error} reload={reload} />}
      {!data && loading && <Loading />}
      {data && (
        <>
          <AccessPoints aps={data.aps} />
          <Nearby n={data.nearby} />
          <Devices devices={data.devices} days={days} />
        </>
      )}
    </div>
  );
}
