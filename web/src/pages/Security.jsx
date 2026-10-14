import { useMemo, useState } from "react";
import { bytes, go, href, shortDate, useApi } from "../lib.js";
import { Failed, Loading } from "../ui.jsx";

// Security (UU-C-087, one list since UU-C-156): every block as one line — an intrusion, or a
// device blocked by one of your rules in one burst. UniFi's System Log event for a burst (when it
// wrote one) and the blocked connections behind it are the same incident, shown together. Ads and
// trackers are summarised apart. Click a line for the details; investigate an outside address;
// hide a noisy rule.

const RANGES = [
  ["today", "Today"],
  ["7d", "7 days"],
  ["30d", "30 days"],
  ["90d", "90 days"],
];
const RISK = { high: "dangerous", medium: "suspicious", low: "low risk" };
const HIDE_KEY = "netlens.hiddenRules";
const PRIVATE = /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./;

function readHidden() {
  try {
    return JSON.parse(localStorage.getItem(HIDE_KEY) || "[]");
  } catch {
    return [];
  }
}

const isIp = (v) => /^\d{1,3}(\.\d{1,3}){3}$/.test(String(v || ""));
const span = (a, b) => (a === b ? shortDate(b) : `${shortDate(a)} – ${shortDate(b)}`);
const outsideOf = (x) => {
  const d = x.event?.detail;
  return [...x.addresses.map((a) => a.ip), d?.destination?.ip, d?.source?.ip, x.event?.target, x.event?.source].find((v) => isIp(v) && !PRIVATE.test(v)) || null;
};
const touches = (x, ip) => x.addresses.some((a) => a.ip === ip) || [x.event?.target, x.event?.source, x.event?.detail?.destination?.ip, x.event?.detail?.source?.ip].includes(ip);

function Panel({ x, range, tab, all, onHide, hidden }) {
  const e = x.event;
  const d = e?.detail;
  const p = new URLSearchParams({ mac: x.mac || "", from: String(x.first), to: String(x.last) });
  if (x.rule) p.set("rule", x.rule);
  if (x.kind === "ad") {
    p.set("kind", "ad");
    p.set("site", x.sites[0]?.name || "");
  }
  const conns = useApi(x.kind !== "intrusion" && x.mac ? `/api/threats/blocked?${p}` : null);
  const c = conns.data;
  const outside = outsideOf(x);
  const same = outside ? all.filter((y) => touches(y, outside)).length : 0;
  return (
    <aside className="panel" aria-label="Block detail">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span className="mono small dim">{span(x.first, x.last)}</span>
        <a className="iconbtn" href={href("security", null, { r: range, tab: tab === "ads" ? "ads" : null })} aria-label="Close">×</a>
      </div>
      <h2 style={{ fontSize: 20, lineHeight: 1.3 }}>{x.kind === "intrusion" ? "Intrusion attempt blocked" : x.kind === "ad" ? `Ad / tracker blocked: ${x.sites[0]?.name || ""}` : `Blocked by “${x.rule || "a rule"}”`}</h2>
      {d?.signature && (
        <p className="note">
          {d.signature}
          {d.risk && <> — UniFi rates it <strong className={d.risk === "high" ? "bad" : "warn"}>{RISK[d.risk] || d.risk}</strong></>}
          {d.note && <>: “{d.note}”</>}
        </p>
      )}
      <div className="kv">
        {x.rule && x.kind === "rule" && <div><span>Rule</span><span>{x.rule}{d?.policyType ? ` · ${d.policyType.replace(/_/g, " ").toLowerCase()}` : ""}</span></div>}
        {d?.signatureId && <div><span>Signature ID</span><span className="mono">{d.signatureId}</span></div>}
        {d?.category && <div><span>Category</span><span>{d.category}</span></div>}
        {d?.cve && <div><span>CVE</span><span>{d.cve}</span></div>}
        <div><span>Action</span><span>blocked · {x.n} attempt{x.n === 1 ? "" : "s"}</span></div>
        {(x.services.length > 0 || d?.service) && <div><span>Service</span><span>{x.services.length ? x.services.join(" · ") : [d.service, d.protocol, d.direction].filter(Boolean).join(" · ")}</span></div>}
        <div><span>Device</span><span>{x.device}{(c?.deviceIp || d?.source?.ip) ? <span className="mono"> · {c?.deviceIp || d?.source?.ip}</span> : null}</span></div>
        <div><span>{x.siteCount > 1 ? `Sites (${x.siteCount})` : "Destination"}</span><span>{x.sites[0]?.name || "—"}{x.sites[0]?.n > 1 && x.siteCount > 1 ? ` ×${x.sites[0].n}` : ""}</span></div>
        {x.sites.slice(1, 8).map((s) => (
          <div key={s.name}><span /><span>{s.name}{s.n > 1 ? <span className="dim"> ×{s.n}</span> : null}</span></div>
        ))}
        {x.siteCount > 8 && <div><span /><span className="dim">+{x.siteCount - 8} more</span></div>}
        {x.addresses.length > 0 && <div><span>Addresses</span><span className="mono">{x.addresses.slice(0, 4).map((a) => a.ip).join(", ")}{x.addresses.length > 4 ? ` +${x.addresses.length - 4}` : ""}</span></div>}
        {(d?.inNetwork || d?.outNetwork) && <div><span>Networks</span><span>{d.inNetwork || "—"} → {d.outNetwork || "—"}</span></div>}
      </div>
      {e && <p className="dim small" style={{ margin: 0 }}>UniFi logged this {x.kind === "intrusion" ? "intrusion" : "block"} in its System Log{d?.traffic?.count > 1 ? ` (${d.traffic.count} attempts to one address)` : ""}.</p>}
      {d?.advanced && <p className="dim small" style={{ margin: 0, overflowWrap: "anywhere" }}>{d.advanced}</p>}
      {c?.attempts?.length > 0 && (
        <div className="rows" style={{ maxHeight: 240, overflow: "auto" }}>
          {c.attempts.map((a, i) => (
            <div key={i} className="row small" style={{ gridTemplateColumns: "120px minmax(0, 1fr) auto", cursor: "default", padding: "3px 6px" }}>
              <span className="mono dim">{shortDate(a.t)}</span>
              <span className="ellipsis">{a.site}{a.ip && a.ip !== a.site ? <span className="dim mono"> · {a.ip}</span> : null}</span>
              <span className="dim">{a.service || ""}</span>
            </div>
          ))}
        </div>
      )}
      {d?.traffic && <div className="kv"><div><span>Traffic</span><span className="mono">{d.traffic.packetsTotal ?? "—"} packets · {bytes(d.traffic.bytesTx)} ↑ {bytes(d.traffic.bytesRx)} ↓{d.traffic.durationMs ? ` · ${(d.traffic.durationMs / 1000).toFixed(1)} s` : ""}</span></div></div>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {x.mac && <a className="btn primary" href={href("device", x.mac)}>{x.device}</a>}
        {outside && <a className="btn" href={href("security", null, { ip: outside, r: "90d" })}>Investigate {outside}{same > 1 ? ` (${same})` : ""}</a>}
        {x.rule && x.kind === "rule" && <button className="btn" onClick={() => onHide(x.rule)}>{hidden.includes(x.rule) ? "Show this rule again" : "Hide this rule"}</button>}
      </div>
    </aside>
  );
}

export default function Security({ route }) {
  const range = route.query.r || (route.query.ip ? "90d" : "7d");
  const { data, error, loading, reload } = useApi(`/api/threats?period=${range}`);
  const [hidden, setHidden] = useState(readHidden);
  const [showHidden, setShowHidden] = useState(false);
  const ip = route.query.ip || null;
  const rule = route.query.rule || null;
  // Drop-down filters (UU-C-158): type, device, site, rule — combined.
  const kind = route.query.kind || "";
  const dev = route.query.dev || "";
  const site = route.query.site || "";
  const setFilter = (patch) => go("security", null, { ...route.query, ...patch, e: null });

  const toggleHide = (r) => {
    const next = hidden.includes(r) ? hidden.filter((x) => x !== r) : [...hidden, r];
    setHidden(next);
    try {
      localStorage.setItem(HIDE_KEY, JSON.stringify(next));
    } catch {
      /* the filter just won't persist */
    }
  };

  // Two tabs (UU-C-160): blocks by your rules and intrusions; ads and trackers. Same layout.
  const tab = route.query.tab === "ads" ? "ads" : "blocks";
  const ads = tab === "ads";
  const all = (ads ? data?.adBlocks?.incidents : data?.incidents) || [];
  const devKey = (x) => x.mac || x.device;
  const list = all.filter((x) => {
    if (ip && !touches(x, ip)) return false;
    if (rule && x.rule !== rule) return false;
    if (kind && x.kind !== kind) return false;
    if (dev && devKey(x) !== dev) return false;
    if (site && !x.sites.some((s) => s.name === site)) return false;
    if (!ads && !ip && !rule && !showHidden && x.kind === "rule" && hidden.includes(x.rule)) return false;
    return true;
  });
  // Options with counts, from the whole period.
  const options = useMemo(() => {
    const count = (pairs) => {
      const m = new Map();
      for (const [k, label] of pairs) if (k) m.set(k, { label, n: (m.get(k)?.n || 0) + 1 });
      return [...m].sort((a, b) => b[1].n - a[1].n).map(([value, v]) => ({ value, label: v.label, n: v.n }));
    };
    return {
      dev: count(all.map((x) => [devKey(x), x.device])),
      site: count(all.flatMap((x) => x.sites.map((s) => [s.name, s.name]))),
      rule: count(all.map((x) => [x.rule, x.rule])),
    };
  }, [all]); // eslint-disable-line react-hooks/exhaustive-deps
  const filtered = Boolean(kind || dev || site || rule);
  const hiddenCount = ads ? 0 : all.filter((x) => x.kind === "rule" && hidden.includes(x.rule)).length;
  const sel = all.find((x) => x.id === route.query.e) || null;

  const days = useMemo(() => {
    const m = new Map();
    for (const x of list) {
      const k = new Date(x.last).toLocaleDateString([], { month: "short", day: "numeric" });
      const cur = m.get(k) || { k, t: 0, f: 0, ts: x.last };
      if (x.kind === "intrusion") cur.t += 1;
      else cur.f += ads ? x.n : 1;
      m.set(k, cur);
    }
    return [...m.values()].sort((a, b) => a.ts - b.ts);
  }, [list]);
  const dmax = Math.max(1, ...days.map((d) => d.t + d.f));
  const intrusions = list.filter((x) => x.kind === "intrusion").length;
  const tops = useMemo(() => {
    const top = (key) => {
      const m = new Map();
      for (const x of list) {
        const k = key(x);
        if (k) m.set(k, (m.get(k) || 0) + 1);
      }
      return [...m].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name, count }));
    };
    const topN = (key) => {
      const m = new Map();
      for (const x of list) {
        const k = key(x);
        if (k) m.set(k, (m.get(k) || 0) + x.n);
      }
      return [...m].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name, count }));
    };
    // Ads count blocked lookups; blocks count incidents.
    return ads
      ? [
          ["Devices", topN((x) => x.device)],
          ["Blocked sites", topN((x) => x.sites[0]?.name)],
        ]
      : [
          ["Devices", top((x) => x.device)],
          ["Sites", top((x) => x.sites[0]?.name)],
          ["Rules & signatures", top((x) => x.rule)],
        ];
  }, [list, ads]);

  return (
    <div className="split">
      <div className="main">
        <div className="page">
          <div className="page-head">
            <div className="titles">
              <span className="dim small">Security</span>
              <h1>{ip ? `Address ${ip}` : "Blocked traffic"}</h1>
              {data && (
                <span className="muted">
                  {ads
                    ? `${list.reduce((n, x) => n + x.n, 0).toLocaleString()} ads and trackers stopped by UniFi's ad blocking`
                    : `${intrusions} intrusion attempt${intrusions === 1 ? "" : "s"} · ${list.length - intrusions} block${list.length - intrusions === 1 ? "" : "s"} by your rules`}
                  {ip && <> · <a href={href("security", null, { r: range })}>show everything</a></>}
                </span>
              )}
            </div>
            <div className="seg" role="group" aria-label="Range">
              {RANGES.map(([id, label]) => (
                <button key={id} className={range === id ? "on" : ""} onClick={() => go("security", null, { ...route.query, r: id, e: null })}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="seg" role="tablist" aria-label="View" style={{ alignSelf: "flex-start" }}>
            {[["blocks", "Blocks & intrusions"], ["ads", "Ads & trackers"]].map(([id, label]) => (
              <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => go("security", null, { r: range, tab: id === "ads" ? "ads" : null })}>
                {label}
                {data ? <span className="dim"> {id === "ads" ? (data.adBlocks?.total || 0).toLocaleString() : data.incidents?.length || 0}</span> : null}
              </button>
            ))}
          </div>
          {error && <Failed error={error} reload={reload} />}
          {!data && loading && <Loading />}
          {data && (
            <>
              {days.length > 1 && (
                <div className="card tight">
                  <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 70 }}>
                    {days.map((d) => (
                      <div key={d.k} title={ads ? `${d.k} · ${d.f} ads and trackers` : `${d.k} · ${d.t} intrusion · ${d.f} blocked by rules`} style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", height: "100%", gap: 2 }}>
                        {d.t > 0 && <span style={{ height: `${(d.t / dmax) * 56}px`, background: "var(--bad)", borderRadius: 3 }} />}
                        {d.f > 0 && <span style={{ height: `${(d.f / dmax) * 56}px`, background: "#8a6a2e", borderRadius: 3 }} />}
                      </div>
                    ))}
                  </div>
                  <div className="axis"><span>{days[0].k}</span><span>{days[days.length - 1].k}</span></div>
                </div>
              )}
              {list.length > 0 && !ip && (
                <div className={`grid ${ads ? "g2" : "g3"}`}>
                  {tops.map(([title, rows]) => (
                    <div key={title} className="card tight">
                      <h2 style={{ fontSize: 14 }}>{title}</h2>
                      {rows.map((r) => (
                        <div key={r.name} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13 }}>
                          <span className="ellipsis">{r.name}</span>
                          <span className="mono dim">{r.count}</span>
                        </div>
                      ))}
                      {!rows.length && <span className="dim small">—</span>}
                    </div>
                  ))}
                </div>
              )}
              <div className="card" style={{ padding: "6px 10px" }}>
                <div className="filters" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", padding: "6px 4px 10px" }}>
                  {!ads && (
                    <select className="field" aria-label="Type" value={kind} onChange={(e) => setFilter({ kind: e.target.value || null })}>
                      <option value="">All types</option>
                      <option value="rule">Blocked by your rules</option>
                      <option value="intrusion">Intrusions</option>
                    </select>
                  )}
                  <select className="field" aria-label="Device" value={dev} onChange={(e) => setFilter({ dev: e.target.value || null })}>
                    <option value="">All devices</option>
                    {options.dev.map((o) => <option key={o.value} value={o.value}>{o.label} ({o.n})</option>)}
                  </select>
                  <select className="field" aria-label="Site" value={site} onChange={(e) => setFilter({ site: e.target.value || null })}>
                    <option value="">All sites</option>
                    {options.site.map((o) => <option key={o.value} value={o.value}>{o.label} ({o.n})</option>)}
                  </select>
                  {!ads && (
                    <select className="field" aria-label="Rule" value={rule || ""} onChange={(e) => setFilter({ rule: e.target.value || null })}>
                      <option value="">All rules & signatures</option>
                      {options.rule.map((o) => <option key={o.value} value={o.value}>{o.label} ({o.n})</option>)}
                    </select>
                  )}
                  {filtered && <button className="btn small" onClick={() => setFilter({ kind: null, dev: null, site: null, rule: null })}>Clear filters</button>}
                  <span className="dim small" style={{ marginLeft: "auto" }}>{list.length} of {all.length}</span>
                </div>
                <div className="rows">
                  {list.map((x) => (
                    <button
                      key={x.id}
                      className={`row ${sel?.id === x.id ? "sel" : ""}`}
                      style={{ gridTemplateColumns: "130px 90px minmax(0, 1.3fr) minmax(0, 1fr) 54px" }}
                      onClick={() => go("security", null, { ...route.query, r: range, e: x.id })}
                    >
                      <span className="mono small dim">{shortDate(x.last)}</span>
                      <span className={x.kind === "intrusion" ? "bad" : x.kind === "ad" ? "dim" : "warn"}>{x.kind === "intrusion" ? "Intrusion" : x.kind === "ad" ? "Ad / tracker" : "Blocked"}</span>
                      <span className="stack">
                        <span className="ellipsis">{x.device} → {x.sites[0]?.name || "—"}{x.siteCount > 1 ? <span className="dim"> +{x.siteCount - 1} more</span> : null}</span>
                        {x.first !== x.last && <span className="dim small">{span(x.first, x.last)}</span>}
                      </span>
                      <span className="muted small ellipsis">{x.rule || "rule not recorded"}</span>
                      <span className="mono small" style={{ textAlign: "right" }}>×{x.n}</span>
                    </button>
                  ))}
                  {!list.length && <div className="empty">Nothing blocked in this period.</div>}
                </div>
                {data.truncated && <p className="dim small" style={{ margin: "6px 0" }}>The 500 most recent.</p>}
              </div>
              {hiddenCount > 0 && !ip && !rule && (
                <button className="btn small" style={{ alignSelf: "flex-start" }} onClick={() => setShowHidden((v) => !v)}>
                  {showHidden ? "Hide" : "Show"} {hiddenCount} block{hiddenCount === 1 ? "" : "s"} from hidden rules
                </button>
              )}
            </>
          )}
        </div>
      </div>
      {sel && <Panel key={sel.id} x={sel} range={range} tab={tab} all={all} onHide={toggleHide} hidden={hidden} />}
    </div>
  );
}
