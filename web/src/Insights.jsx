import { useEffect, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

// Gateway/WAN strip and the Wi-Fi, Equipment and Threats pages (UU-C-056). Data comes from
// /api/gateway, /api/wifi, /api/equipment and /api/threats, all served from the app's own
// database — the samples the container takes every 5 minutes and UniFi's System Log.

const C = { grid: "#242d3e", axis: "#8a96ab", a: "#38bdf8", b: "#2dd4bf", c: "#a78bfa", d: "#fbbf24", weak: "#f59e0b", bad: "#ef4444" };
const tipStyle = { background: "#131823", border: "1px solid #242d3e", borderRadius: 10 };

const fmtUptime = (s) => {
  if (!s) return "—";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return d ? `${d}d ${h}h` : `${h}h ${Math.floor((s % 3600) / 60)}m`;
};
const fmtMin = (m) => (m == null ? "—" : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60 ? `${m % 60}m` : ""}`.trim() : `${m}m`);
const fmtPct = (v) => (v == null ? "—" : `${Math.round(v)}%`);
const fmtTemp = (v) => (v == null ? "—" : `${Math.round(v)}°C`);
const fmtRate = (kbps) => (kbps == null ? "—" : kbps >= 1000 ? `${Math.round(kbps / 1000)} Mbps` : `${kbps} kbps`);
const sigClass = (s) => (s == null ? "" : s < -80 ? "sig-bad" : s < -75 ? "sig-weak" : "sig-ok");

function useJson(api, path) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setError("");
    api(path)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [api, path]);
  return { data, error };
}

function axisTime(tz, multiDay) {
  return (t) =>
    new Intl.DateTimeFormat("en-US", multiDay ? { timeZone: tz, month: "short", day: "numeric" } : { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(t));
}

// ---- gateway strip -------------------------------------------------------------------

export function GatewayStrip({ api }) {
  const [g, setG] = useState(null);
  useEffect(() => {
    let live = true;
    const load = () => api("/api/gateway").then((d) => live && setG(d)).catch(() => {});
    load();
    const id = setInterval(load, 60000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [api]);
  if (!g || !g.sampledAt) return null;
  const ok = g.status === "ok";
  return (
    <div className="gw-strip">
      <span className={`gw-dot ${ok ? "ok" : "bad"}`} />
      <span>
        <strong>Internet {ok ? "OK" : g.status || "unknown"}</strong>
        {g.isp ? ` · ${g.isp}` : ""}
      </span>
      <span className="muted">
        latency {g.latency ?? "—"} ms{g.day?.latencyMax ? ` (24h max ${g.day.latencyMax})` : ""} · availability {fmtPct(g.availability)}
        {g.day?.availabilityMin != null && g.day.availabilityMin < 100 ? ` (24h min ${fmtPct(g.day.availabilityMin)})` : ""}
      </span>
      {g.gateway && (
        <span className="muted">
          {g.gateway.name}: CPU {fmtPct(g.gateway.cpu)} · RAM {fmtPct(g.gateway.mem)} · {fmtTemp(g.gateway.temp)} · up {fmtUptime(g.gateway.uptime)}
        </span>
      )}
      {g.clients && (
        <span className="muted">
          {g.clients.wifi ?? 0} Wi-Fi · {g.clients.wired ?? 0} wired
        </span>
      )}
    </div>
  );
}

export function PageTabs({ page, setPage }) {
  const tabs = [
    ["usage", "Usage"],
    ["wifi", "Wi-Fi"],
    ["equipment", "Equipment"],
    ["threats", "Threats"],
  ];
  return (
    <div className="page-tabs">
      {tabs.map(([id, label]) => (
        <button key={id} className={page === id ? "btn" : "btn ghost"} onClick={() => setPage(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}

// ---- Wi-Fi ---------------------------------------------------------------------------

function Heatmap({ minutes }) {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return (
    <div className="heatmap">
      <div />
      {days.map((d) => (
        <div key={d} className="hm-head">
          {d}
        </div>
      ))}
      {minutes.map((row, h) => [
        <div key={`h${h}`} className="hm-hour">
          {String(h).padStart(2, "0")}
        </div>,
        ...row.map((v, d) => (
          <div
            key={`${h}-${d}`}
            className="hm-cell"
            title={`${days[d]} ${String(h).padStart(2, "0")}:00 — ${v} min connected on average`}
            style={{ background: `rgba(56, 189, 248, ${Math.min(1, v / 60) * 0.85 + (v ? 0.08 : 0)})` }}
          />
        )),
      ])}
    </div>
  );
}

function WifiDetail({ api, q, mac, onBack }) {
  const { data: c, error } = useJson(api, `/api/wifi?${q}&mac=${encodeURIComponent(mac)}`);
  if (error) return <div className="error">{error}</div>;
  if (!c) return <div className="loading">Loading…</div>;
  const multiDay = c.end - c.start > 36 * 3600e3;
  return (
    <>
      <div className="card">
        <div className="row">
          <h3>{c.name} — Wi-Fi</h3>
          <button className="btn ghost" onClick={onBack}>
            All Wi-Fi devices
          </button>
        </div>
        {c.wired ? (
          <p className="muted">This device is wired, so there is no Wi-Fi signal to show.</p>
        ) : c.current ? (
          <p>
            Now on <strong>{c.current.ap}</strong> · {c.current.band} ch {c.current.channel}
            {c.current.width ? ` (${c.current.width} MHz)` : ""} · <span className={sigClass(c.current.signal)}>{c.current.signal} dBm</span>
            {c.current.noise != null ? <span className="muted"> (noise {c.current.noise})</span> : null} · link {fmtRate(c.current.txRate)} / {fmtRate(c.current.rxRate)}
            {c.current.satisfaction != null ? ` · experience ${c.current.satisfaction}%` : ""}
          </p>
        ) : (
          <p className="muted">No Wi-Fi samples for this device in this period.</p>
        )}
        <div className="stats" style={{ marginTop: 8 }}>
          <div className="card">
            <div className="stat-label">Average signal</div>
            <div className={`stat-value ${sigClass(c.summary.avgSignal)}`}>{c.summary.avgSignal ?? "—"} dBm</div>
          </div>
          <div className="card">
            <div className="stat-label">Weak (below {c.thresholds.weak})</div>
            <div className="stat-value">{fmtMin(c.summary.weakMinutes)}</div>
            <div className="muted">of {fmtMin(c.summary.minutes)} connected</div>
          </div>
          <div className="card">
            <div className="stat-label">Poor (below {c.thresholds.bad})</div>
            <div className={`stat-value ${c.summary.badMinutes ? "sig-bad" : ""}`}>{fmtMin(c.summary.badMinutes)}</div>
          </div>
          <div className="card">
            <div className="stat-label">Roams</div>
            <div className="stat-value">{c.roams.length}</div>
            <div className="muted">{c.favoriteAp ? `favourite AP: ${c.favoriteAp.ap} (${c.favoriteAp.hours} h / 30 days)` : ""}</div>
          </div>
        </div>
      </div>

      {c.series.length > 0 && (
        <div className="card">
          <h3>Signal over time</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            Sampled every 5 minutes. Below {c.thresholds.weak} dBm is weak; below {c.thresholds.bad} dBm pages start to stall.
          </p>
          <div style={{ height: 260 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={c.series}>
                <CartesianGrid stroke={C.grid} vertical={false} />
                <XAxis dataKey="t" type="number" domain={[c.start, Math.min(c.end, Date.now())]} tickFormatter={axisTime(c.tz, multiDay)} stroke={C.axis} />
                <YAxis domain={[-95, -30]} stroke={C.axis} width={48} />
                <Tooltip
                  contentStyle={tipStyle}
                  labelFormatter={(t) => new Date(t).toLocaleString()}
                  formatter={(v, n, p) => [`${v} dBm`, n === "signal" ? `${p.payload.ap} · ${p.payload.band}` : "lowest"]}
                />
                <ReferenceLine y={c.thresholds.weak} stroke={C.weak} strokeDasharray="4 4" />
                <ReferenceLine y={c.thresholds.bad} stroke={C.bad} strokeDasharray="4 4" />
                <Line dataKey="signal" stroke={C.a} dot={false} strokeWidth={2} isAnimationActive={false} />
                <Line dataKey="minSignal" stroke={C.c} dot={false} strokeWidth={1} strokeOpacity={0.6} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      <div className="split">
        <div className="card">
          <h3>Time per access point</h3>
          <table>
            <thead>
              <tr>
                <th>Access point</th>
                <th>Band</th>
                <th>Time</th>
                <th>Avg signal</th>
              </tr>
            </thead>
            <tbody>
              {c.dwell.map((d) => (
                <tr key={`${d.ap}-${d.band}`}>
                  <td>{d.ap}</td>
                  <td className="muted">{d.band}</td>
                  <td>{fmtMin(d.minutes)}</td>
                  <td className={sigClass(d.avgSignal)}>{d.avgSignal ?? "—"} dBm</td>
                </tr>
              ))}
              {!c.dwell.length && (
                <tr>
                  <td colSpan={4} className="muted">
                    No samples in this period.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="card">
          <h3>When it is usually connected</h3>
          {c.presence.sufficient ? (
            <Heatmap minutes={c.presence.minutes} />
          ) : (
            <p className="muted">
              Needs 7 days of samples to show a pattern — {c.presence.daysOfData} {c.presence.daysOfData === 1 ? "day" : "days"} so far.
            </p>
          )}
        </div>
      </div>

      <div className="card">
        <h3>Roams</h3>
        <table>
          <tbody>
            {c.roams.slice(0, 40).map((r, i) => (
              <tr key={`${r.ts}-${i}`}>
                <td>{new Date(r.ts).toLocaleString()}</td>
                <td className="muted">{r.msg}</td>
              </tr>
            ))}
            {!c.roams.length && (
              <tr>
                <td className="muted">No roams in this period.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function WifiPage({ api, q, selected, setSelected }) {
  const { data, error } = useJson(api, `/api/wifi?${q}`);
  if (selected && selected !== "all") return <WifiDetail api={api} q={q} mac={selected} onBack={() => setSelected("all")} />;
  if (error) return <div className="error">{error}</div>;
  if (!data) return <div className="loading">Loading…</div>;
  return (
    <div className="card">
      <h3>Wi-Fi devices</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Worst signal first. Sampled every 5 minutes; "poor" is time below {data.thresholds.bad} dBm. Click a device for its signal history,
        access points, roams and when it is usually connected.
      </p>
      <table>
        <thead>
          <tr>
            <th>Device</th>
            <th>Access point</th>
            <th>Signal now</th>
            <th>Average</th>
            <th>Poor</th>
            <th>Roams</th>
          </tr>
        </thead>
        <tbody>
          {data.clients.map((c) => (
            <tr key={c.mac} className="row-click" onClick={() => setSelected(c.mac)}>
              <td>{c.name}</td>
              <td className="muted">
                {c.ap} · {c.band}
              </td>
              <td className={sigClass(c.signal)}>{c.signal ?? "—"} dBm</td>
              <td className={sigClass(c.avgSignal)}>{c.avgSignal ?? "—"} dBm</td>
              <td className={c.badShare ? "sig-bad" : "muted"}>{fmtPct(c.badShare)}</td>
              <td>{c.roams}</td>
            </tr>
          ))}
          {!data.clients.length && (
            <tr>
              <td colSpan={6} className="muted">
                No Wi-Fi samples in this period yet — they are collected every 5 minutes from now on.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---- Equipment -----------------------------------------------------------------------

function EquipmentPage({ api, q }) {
  const { data, error } = useJson(api, `/api/equipment?${q}`);
  if (error) return <div className="error">{error}</div>;
  if (!data) return <div className="loading">Loading…</div>;
  const multiDay = data.end - data.start > 36 * 3600e3;
  const bandColor = { ng: C.d, na: C.b, "6e": C.c };
  return (
    <>
      {data.devices.map((d) => (
        <div key={d.mac} className="card">
          <div className="row">
            <h3>
              {d.name} <span className="muted">· {d.model}</span>
            </h3>
            <span className={d.online ? "sig-ok" : "sig-bad"}>
              {d.online ? "online" : "offline"}
              {d.firmware ? <span className="muted"> · firmware {d.firmware}</span> : null}
              {d.upgradable ? <span className="sig-weak"> · update available</span> : null}
            </span>
          </div>
          {d.latest && (
            <div className="stats" style={{ marginTop: 8 }}>
              <div className="card">
                <div className="stat-label">CPU</div>
                <div className="stat-value">{fmtPct(d.latest.cpu)}</div>
                <div className="muted">peak {fmtPct(d.peak.cpu)}</div>
              </div>
              <div className="card">
                <div className="stat-label">Memory</div>
                <div className="stat-value">{fmtPct(d.latest.mem)}</div>
                <div className="muted">peak {fmtPct(d.peak.mem)}</div>
              </div>
              {d.latest.temp != null && (
                <div className="card">
                  <div className="stat-label">Temperature</div>
                  <div className="stat-value">{fmtTemp(d.latest.temp)}</div>
                  <div className="muted">{d.latest.temps.map((t) => `${t.name} ${fmtTemp(t.value)}`).join(" · ")}</div>
                </div>
              )}
              <div className="card">
                <div className="stat-label">Clients · uptime</div>
                <div className="stat-value">{d.latest.clients ?? "—"}</div>
                <div className="muted">up {fmtUptime(d.latest.uptime)}</div>
              </div>
            </div>
          )}
          {d.latest?.radios?.length > 0 && (
            <div style={{ margin: "10px 0" }}>
              {d.latest.radios.map((r) => (
                <div key={r.radio} className="radio-row">
                  <span>
                    {r.band} · ch {r.channel} · {r.clients ?? 0} clients
                  </span>
                  <div className="bar" title="Channel utilisation: how busy the air is, including neighbours">
                    <span style={{ width: `${Math.max(2, r.util || 0)}%` }} />
                  </div>
                  <span className={r.util > 50 ? "sig-weak" : "muted"}>{fmtPct(r.util)} busy</span>
                </div>
              ))}
            </div>
          )}
          {d.latest?.ports?.length > 0 && (
            <p className="muted" style={{ margin: "6px 0" }}>
              Ports:{" "}
              {d.latest.ports
                .map((p) => `${p.name}: ${p.up ? `${p.speed >= 1000 ? `${p.speed / 1000} G` : `${p.speed} M`}` : "down"}${p.poe ? ` PoE ${p.poe} W` : ""}${p.rxErrors || p.txErrors ? ` (${(p.rxErrors || 0) + (p.txErrors || 0)} errors)` : ""}`)
                .join(" · ")}
            </p>
          )}
          {d.latest?.uplink && (
            <p className="muted" style={{ margin: "6px 0" }}>
              Uplink: {d.latest.uplink.speed >= 1000 ? `${d.latest.uplink.speed / 1000} Gbps` : `${d.latest.uplink.speed} Mbps`}
              {d.latest.uplink.device ? ` to ${d.latest.uplink.device} port ${d.latest.uplink.port}` : ""}
            </p>
          )}
          {d.series.length > 1 && (
            <div style={{ height: 200 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={d.series}>
                  <CartesianGrid stroke={C.grid} vertical={false} />
                  <XAxis dataKey="t" type="number" domain={[data.start, Math.min(data.end, Date.now())]} tickFormatter={axisTime(data.tz, multiDay)} stroke={C.axis} />
                  <YAxis domain={[0, 100]} stroke={C.axis} width={40} unit="%" />
                  <Tooltip contentStyle={tipStyle} labelFormatter={(t) => new Date(t).toLocaleString()} />
                  <Legend />
                  <Line dataKey="cpu" name="CPU %" stroke={C.a} dot={false} isAnimationActive={false} />
                  <Line dataKey="mem" name="Memory %" stroke={C.b} dot={false} isAnimationActive={false} />
                  {d.radios.map((r) => (
                    <Line key={r.radio} dataKey={`util_${r.radio}`} name={`${r.band} busy %`} stroke={bandColor[r.radio] || C.c} dot={false} strokeDasharray="4 2" isAnimationActive={false} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      ))}
      {!data.devices.length && <div className="card muted">No equipment samples yet — they are collected every 5 minutes from now on.</div>}
    </>
  );
}

// ---- Threats -------------------------------------------------------------------------

function TopList({ title, rows }) {
  return (
    <div className="card">
      <h3>{title}</h3>
      <table>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td>{r.name}</td>
              <td style={{ textAlign: "right" }}>{r.count}</td>
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td className="muted">None in this period.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function ThreatsPage({ api, q }) {
  const { data, error } = useJson(api, `/api/threats?${q}`);
  if (error) return <div className="error">{error}</div>;
  if (!data) return <div className="loading">Loading…</div>;
  return (
    <>
      <div className="stats">
        <div className="card">
          <div className="stat-label">Security events</div>
          <div className="stat-value">{data.total}</div>
        </div>
        <div className="card">
          <div className="stat-label">Threats blocked (IPS)</div>
          <div className={`stat-value ${data.threats ? "sig-weak" : ""}`}>{data.threats}</div>
        </div>
        <div className="card">
          <div className="stat-label">Blocked by your firewall rules</div>
          <div className="stat-value">{data.firewall}</div>
        </div>
      </div>
      <div className="split">
        <TopList title="Top sources" rows={data.topSources} />
        <TopList title="Top targets" rows={data.topTargets} />
        <TopList title="Rules that fired" rows={data.topPolicies} />
      </div>
      <div className="card">
        <h3>Events</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          From UniFi's System Log, kept 90 days. UniFi does not include the IPS signature name in these events.
        </p>
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Type</th>
              <th>Source</th>
              <th>Target</th>
              <th>Rule</th>
            </tr>
          </thead>
          <tbody>
            {data.items.slice(0, 150).map((it, i) => (
              <tr key={`${it.ts}-${i}`} title={it.msg || ""}>
                <td>{new Date(it.ts).toLocaleString()}</td>
                <td className={it.kind === "Threat blocked" ? "sig-weak" : "muted"}>{it.kind}</td>
                <td>{it.source || "—"}</td>
                <td className="muted">{it.target || "—"}</td>
                <td className="muted">{it.policy || "—"}</td>
              </tr>
            ))}
            {!data.items.length && (
              <tr>
                <td colSpan={5} className="muted">
                  No security events in this period.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function InsightsPage({ page, api, period, date, selected, setSelected }) {
  const q = `period=${encodeURIComponent(period)}${date ? `&date=${encodeURIComponent(date)}` : ""}`;
  if (page === "wifi") return <WifiPage api={api} q={q} selected={selected} setSelected={setSelected} />;
  if (page === "equipment") return <EquipmentPage api={api} q={q} />;
  if (page === "threats") return <ThreatsPage api={api} q={q} />;
  return null;
}
