import { useState } from "react";
import { clock, shortDate, speed, useApi } from "../lib.js";
import { Bars, Failed, Loading } from "../ui.jsx";

// Internet (UU-C-239): did the line deliver? Availability and every outage, latency to UniFi's
// test targets, how much of the line the busiest moments used, the public address over time and
// UniFi's last speed test. On Network 11 the busiest moments are each 5 minutes' peak from its
// statistics engine; before, the rate at each update.

const DAYS = [[1, "24 hours"], [7, "7 days"], [30, "30 days"]];
const mbps = (v) => (v == null ? "—" : v >= 1000 ? `${(v / 1000).toFixed(2)} Gbps` : `${v >= 100 ? Math.round(v) : v} Mbps`);
const dur = (m) => (m >= 120 ? `${Math.round(m / 6) / 10} h` : `${m} min`);

export default function Internet() {
  const [days, setDays] = useState(1);
  const { data: d, error, loading, reload } = useApi(`/api/internet?days=${days}`, 5 * 60 * 1000);
  const when = (t) => (days === 1 ? clock(t) : shortDate(t));
  const share = (p) => (p && d?.linkMbps ? ` · ${Math.round((p.mbps / d.linkMbps) * 100)}% of the line` : "");
  return (
    <div className="page wide">
      <div className="page-head">
        <div className="titles">
          <span className="dim small">Network · Internet</span>
          <h1>Internet</h1>
          {d && (
            <span className="muted">
              {d.isp || "Your internet line"}
              {d.linkMbps ? ` · ${speed(d.linkMbps)} line` : ""}
              {d.status ? (d.status.ok ? ` · online, ${d.status.latency ?? "—"} ms` : ` · ${d.status.status || "down"}`) : ""}
            </span>
          )}
        </div>
        <div className="seg" role="group" aria-label="Period">
          {DAYS.map(([n, label]) => (
            <button key={n} className={days === n ? "on" : ""} aria-pressed={days === n} onClick={() => setDays(n)}>{label}</button>
          ))}
        </div>
      </div>
      {error && <Failed error={error} reload={reload} />}
      {!d && loading && <Loading />}
      {d && !d.samples && <div className="card empty">Nothing recorded in this period.</div>}
      {d?.samples > 0 && (
        <>
          <section className="card">
            <div className="kv">
              <div>
                <span>Available</span>
                <span className={`mono ${d.availability != null && d.availability < 99.9 ? "warn" : ""}`}>
                  {d.availability != null ? `${d.availability}%` : "—"} <span className="dim small">of {d.seenHours} h NetLens watched</span>
                </span>
              </div>
              <div><span>Outages</span><span className={`mono ${d.outageCount ? "bad" : ""}`}>{d.outageCount}</span></div>
              <div><span>Latency</span><span className="mono">{d.latency.avg != null ? `${d.latency.avg} ms average · ${d.latency.p95} ms on a bad moment (95th) · ${d.latency.max} ms worst` : "—"}</span></div>
              <div><span>Busiest download</span><span className="mono">{d.peakDown ? `${mbps(d.peakDown.mbps)}${share(d.peakDown)} · ${when(d.peakDown.at)}` : "—"}</span></div>
              <div><span>Busiest upload</span><span className="mono">{d.peakUp ? `${mbps(d.peakUp.mbps)}${share(d.peakUp)} · ${when(d.peakUp.at)}` : "—"}</span></div>
              <div><span>Public address</span><span className="mono">{d.ip || "—"}</span></div>
              <div>
                <span>Speed test</span>
                <span className="mono">
                  {d.speedtest ? `↓ ${mbps(d.speedtest.down)} · ↑ ${mbps(d.speedtest.up)} · ${d.speedtest.ping ?? "—"} ms · ${shortDate(d.speedtest.at)}${d.speedtest.server ? ` · ${d.speedtest.server}` : ""}` : <span className="dim">UniFi has no result; run one from UniFi's internet settings and it shows here</span>}
                </span>
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2>Over time</h2>
              <span className="hint">{d.engine ? "Busiest 5 minutes per bar, from UniFi's statistics engine." : "Busiest update per bar."} Download bars are on the scale of your line{d.linkMbps ? ` (${speed(d.linkMbps)})` : ""}.</span>
            </div>
            <div className="history-radio">
              <div className="kv"><div><span>Download</span><span className="mono small dim">busiest Mbps per bar</span></div></div>
              <Bars short max={d.linkMbps || undefined} items={d.series.map((p) => ({
                value: p.downPeak || 0,
                nodata: p.nodata && p.downPeak == null,
                color: p.outage ? "var(--bad)" : undefined,
                tip: p.nodata && p.downPeak == null ? `${when(p.t)}: nothing recorded` : `${when(p.t)}: busiest ↓ ${mbps(p.downPeak)}, average ${mbps(p.down)}${p.outage ? " · outage" : ""}`,
              }))} />
            </div>
            <div className="history-radio">
              <div className="kv"><div><span>Upload</span><span className="mono small dim">busiest Mbps per bar, on its own scale</span></div></div>
              <Bars short items={d.series.map((p) => ({
                value: p.upPeak || 0,
                nodata: p.nodata && p.upPeak == null,
                color: p.outage ? "var(--bad)" : undefined,
                tip: p.nodata && p.upPeak == null ? `${when(p.t)}: nothing recorded` : `${when(p.t)}: busiest ↑ ${mbps(p.upPeak)}, average ${mbps(p.up)}`,
              }))} />
            </div>
            <div className="history-radio">
              <div className="kv"><div><span>Latency</span><span className="mono small dim">ms</span></div></div>
              <Bars short items={d.series.map((p) => ({
                value: p.latency || 0,
                nodata: p.latency == null,
                color: p.outage ? "var(--bad)" : undefined,
                tip: p.latency == null ? `${when(p.t)}: nothing recorded` : `${when(p.t)}: ${p.latency} ms${p.outage ? " · outage" : ""}`,
              }))} />
            </div>
          </section>

          <section className="card">
            <h2>Outages</h2>
            {d.outages.length ? (
              <div className="scroll-x">
                <table className="t">
                  <thead><tr><th>From</th><th>To</th><th className="num">Length</th><th>UniFi said</th></tr></thead>
                  <tbody>
                    {d.outages.map((o) => (
                      <tr key={o.from}>
                        <td className="mono small">{shortDate(o.from)}</td>
                        <td className="mono small">{o.to ? shortDate(o.to) : <span className="bad">still down</span>}</td>
                        <td className="num mono">{dur(o.minutes)}</td>
                        <td className="small dim">{o.status || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="small ok" style={{ margin: 0 }}>No outages while NetLens was watching.</p>
            )}
            <p className="small dim" style={{ margin: 0 }}>From NetLens's update every 5 minutes, so a drop shorter than that can be missed.</p>
          </section>

          <div className="wifi-channel-grid">
            <section className="card">
              <h2>Test targets</h2>
              <p className="small muted" style={{ margin: 0 }}>UniFi checks these all the time; one slow target is that service, all slow is your line.</p>
              <div className="scroll-x">
                <table className="t">
                  <thead><tr><th>Target</th><th>Check</th><th className="num">Latency</th><th className="num">Available</th></tr></thead>
                  <tbody>
                    {d.targets.map((t) => (
                      <tr key={`${t.target}|${t.type}`}>
                        <td className="mono small">{t.target}</td>
                        <td className="small dim">{t.type === "icmp" ? "ping" : t.type === "dns" ? "DNS lookup" : t.type}</td>
                        <td className="num mono">{t.latency != null ? `${t.latency} ms` : "—"}</td>
                        <td className={`num mono ${t.availability != null && t.availability < 100 ? "warn" : ""}`}>{t.availability != null ? `${t.availability}%` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="card">
              <h2>Public address</h2>
              {d.ipHistory.length ? (
                <div className="kv">
                  {d.ipHistory.map((r) => (
                    <div key={`${r.ip}-${r.from}`}>
                      <span className="mono">{r.ip}</span>
                      <span className="small dim">{shortDate(r.from)} – {d.status && r.to >= d.status.ts ? "now" : shortDate(r.to)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="small dim" style={{ margin: 0 }}>Not recorded in this period.</p>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
