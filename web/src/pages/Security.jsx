import { useMemo, useState } from "react";
import { bytes, go, href, shortDate, useApi } from "../lib.js";
import { Failed, Loading } from "../ui.jsx";

// Security (UU-C-087): blocked intrusions and firewall-rule hits. Click an event for the
// blocked connection's full record; investigate an outside address; hide a noisy rule.

const RANGES = [
  ["today", "Today"],
  ["7d", "7 days"],
  ["30d", "30 days"],
  ["90d", "90 days"],
];
const RISK = { high: "dangerous", medium: "suspicious", low: "low risk" };
const HIDE_KEY = "netlens.hiddenRules";

function readHidden() {
  try {
    return JSON.parse(localStorage.getItem(HIDE_KEY) || "[]");
  } catch {
    return [];
  }
}

const isIp = (v) => /^\d{1,3}(\.\d{1,3}){3}$/.test(String(v || ""));

function Detail({ it, all, onHide, hidden }) {
  const d = it.detail;
  const outside = [d?.destination?.ip, d?.source?.ip, it.target, it.source].find((v) => isIp(v) && !/^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(v));
  const same = outside ? all.filter((x) => [x.target, x.source, x.detail?.destination?.ip, x.detail?.source?.ip].includes(outside)).length : 0;
  const rule = d?.policy || it.policy;
  return (
    <aside className="panel" aria-label="Event detail">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span className="mono small dim">{shortDate(it.ts)}</span>
        <a className="iconbtn" href={href("security", null, { r: new URLSearchParams(location.hash.split("?")[1]).get("r") })} aria-label="Close">×</a>
      </div>
      <h2 style={{ fontSize: 20, lineHeight: 1.3 }}>{it.kind === "Threat blocked" ? "Intrusion attempt blocked" : `Blocked by “${rule || "a firewall rule"}”`}</h2>
      {d?.signature && (
        <p className="note">
          {d.signature}
          {d.risk && <> — UniFi rates it <strong className={d.risk === "high" ? "bad" : "warn"}>{RISK[d.risk] || d.risk}</strong></>}
          {d.note && <>: “{d.note}”</>}
        </p>
      )}
      {!d && (
        <p className="note warn">
          {Date.now() - it.ts > 4 * 86400000
            ? "No connection details: UniFi keeps connection records only about 4 days, and this one was gone before NetLens could read it."
            : "No connection record was found for this event (UniFi did not log one, or NetLens has not looked it up yet)."}
        </p>
      )}
      <div className="kv">
        {rule && <div><span>Policy</span><span>{rule}{d?.policyType ? ` · ${d.policyType.replace(/_/g, " ").toLowerCase()}` : ""}</span></div>}
        {d?.signatureId && <div><span>Signature ID</span><span className="mono">{d.signatureId}</span></div>}
        {d?.category && <div><span>Category</span><span>{d.category}</span></div>}
        {d?.cve && <div><span>CVE</span><span>{d.cve}</span></div>}
        {d && <div><span>Action</span><span>{d.action || "blocked"}{d.traffic?.count > 1 ? ` · ${d.traffic.count} attempts` : ""}</span></div>}
        {d && <div><span>Service</span><span>{[d.service, d.protocol, d.direction].filter(Boolean).join(" · ") || "—"}</span></div>}
        <div><span>Source</span><span>{d?.source?.name || it.source || "—"}{d?.source?.ip ? <span className="mono"> · {d.source.ip}{d.source.port != null ? `:${d.source.port}` : ""}</span> : null}</span></div>
        {d?.source?.manufacturer && <div><span>Manufacturer</span><span>{d.source.manufacturer}</span></div>}
        <div><span>Destination</span><span>{d?.destination?.domain || d?.destination?.name || it.target || "—"}</span></div>
        {d?.destination?.ip && <div><span /><span className="mono">{d.destination.ip}{d.destination.port != null ? `:${d.destination.port}` : ""}{d.destination.region ? ` · ${d.destination.region}` : ""}</span></div>}
        {(d?.inNetwork || d?.outNetwork) && <div><span>Networks</span><span>{d.inNetwork || "—"} → {d.outNetwork || "—"}</span></div>}
        {d?.traffic && <div><span>Traffic</span><span className="mono">{d.traffic.packetsTotal ?? "—"} packets · {bytes(d.traffic.bytesTx)} ↑ {bytes(d.traffic.bytesRx)} ↓{d.traffic.durationMs ? ` · ${(d.traffic.durationMs / 1000).toFixed(1)} s` : ""}</span></div>}
      </div>
      {d?.advanced && <p className="dim small" style={{ margin: 0, overflowWrap: "anywhere" }}>{d.advanced}</p>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {d?.source?.mac && <a className="btn primary" href={href("device", d.source.mac)}>{d.source.name || "Source device"}</a>}
        {outside && <a className="btn" href={href("security", null, { ip: outside, r: "90d" })}>Investigate {outside}{same > 1 ? ` (${same})` : ""}</a>}
        {rule && it.kind === "Firewall block" && (
          <button className="btn" onClick={() => onHide(rule)}>{hidden.includes(rule) ? "Show this rule again" : "Hide this rule"}</button>
        )}
      </div>
    </aside>
  );
}

// One "Blocked by your rules" row opened (UU-C-153): the connections behind it.
function BlockDetail({ q, range }) {
  const p = new URLSearchParams({ period: range, mac: q.bm, dest: q.bd });
  if (q.br) p.set("rule", q.br);
  const { data: b, error } = useApi(`/api/threats/blocked?${p}`);
  const outside = (b?.addresses || []).map((a) => a.ip).find((v) => isIp(v) && !/^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(v));
  return (
    <aside className="panel" aria-label="Blocked connections detail">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span className="mono small dim">{b?.last ? shortDate(b.last) : ""}</span>
        <a className="iconbtn" href={href("security", null, { r: q.r })} aria-label="Close">×</a>
      </div>
      <h2 style={{ fontSize: 20, lineHeight: 1.3 }}>{q.br ? `Blocked by “${q.br}”` : "Blocked (rule not recorded)"}</h2>
      {!q.br && <p className="note warn">Saved before NetLens recorded rule names; NetLens fills them in while UniFi still has the record (about 4 days).</p>}
      {error && <p className="note warn">{error.message || String(error)}</p>}
      {b && (
        <>
          <div className="kv">
            <div><span>Action</span><span>blocked · {b.n} attempt{b.n === 1 ? "" : "s"}</span></div>
            <div><span>When</span><span>{b.first === b.last ? shortDate(b.last) : `${shortDate(b.first)} – ${shortDate(b.last)}`}</span></div>
            {b.services.length > 0 && <div><span>Service</span><span>{b.services.join(" · ")}</span></div>}
            <div><span>Source</span><span>{b.device}{b.deviceIp ? <span className="mono"> · {b.deviceIp}</span> : null}</span></div>
            <div><span>Destination</span><span>{b.destination}</span></div>
            {b.addresses.slice(0, 8).map((a) => (
              <div key={a.ip}><span /><span className="mono">{a.ip}{a.n > 1 ? ` ×${a.n}` : ""}</span></div>
            ))}
            {b.addresses.length > 8 && <div><span /><span className="dim">+{b.addresses.length - 8} more addresses</span></div>}
          </div>
          <div className="rows" style={{ maxHeight: 260, overflow: "auto" }}>
            {b.attempts.map((a, i) => (
              <div key={i} className="row small" style={{ gridTemplateColumns: "130px minmax(0, 1fr) auto", cursor: "default", padding: "3px 6px" }}>
                <span className="mono dim">{shortDate(a.t)}</span>
                <span className="mono ellipsis">{a.ip || "—"}</span>
                <span className="dim">{a.service || ""}</span>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <a className="btn primary" href={href("device", b.mac)}>{b.device}</a>
            {outside && <a className="btn" href={href("security", null, { ip: outside, r: "90d" })}>Investigate {outside}</a>}
          </div>
        </>
      )}
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

  const toggleHide = (r) => {
    const next = hidden.includes(r) ? hidden.filter((x) => x !== r) : [...hidden, r];
    setHidden(next);
    try {
      localStorage.setItem(HIDE_KEY, JSON.stringify(next));
    } catch {
      /* the filter just won't persist */
    }
  };

  const all = data?.items || [];
  const list = all.filter((it) => {
    if (ip) return [it.source, it.target, it.detail?.destination?.ip, it.detail?.source?.ip].includes(ip);
    if (rule) return (it.policy || it.detail?.policy) === rule;
    return showHidden || !hidden.includes(it.policy);
  });
  const hiddenCount = all.filter((it) => hidden.includes(it.policy)).length;
  const sel = all.find((it) => it.uid === route.query.e) || null;

  const days = useMemo(() => {
    const m = new Map();
    for (const it of list) {
      const k = new Date(it.ts).toLocaleDateString([], { month: "short", day: "numeric" });
      const cur = m.get(k) || { k, t: 0, f: 0, ts: it.ts };
      if (it.kind === "Threat blocked") cur.t += 1;
      else cur.f += 1;
      m.set(k, cur);
    }
    return [...m.values()].sort((a, b) => a.ts - b.ts);
  }, [list]);
  const dmax = Math.max(1, ...days.map((d) => d.t + d.f));
  // Blocked connections from the connection records (UU-C-148), filterable by rule.
  const [connRule, setConnRule] = useState(null);
  const bc = data?.blockedConnections;
  const ruleKey = (r) => r ?? "";
  const connRows = (bc?.rows || []).filter((b) => (rule ? b.rule === rule : connRule == null || ruleKey(b.rule) === connRule));
  const threats = list.filter((i) => i.kind === "Threat blocked").length;

  return (
    <div className="split">
      <div className="main">
        <div className="page">
          <div className="page-head">
            <div className="titles">
              <span className="dim small">Security</span>
              <h1>{ip ? `Address ${ip}` : rule ? `Rule “${rule}”` : "Blocked traffic"}</h1>
              {data && (
                <span className="muted">
                  {threats} intrusion attempt{threats === 1 ? "" : "s"} · {list.length - threats} firewall block{list.length - threats === 1 ? "" : "s"}
                  {(ip || rule) && <> · <a href={href("security", null, { r: range })}>show everything</a></>}
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
          {error && <Failed error={error} reload={reload} />}
          {!data && loading && <Loading />}
          {data && (
            <>
              {days.length > 1 && (
                <div className="card tight">
                  <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 70 }}>
                    {days.map((d) => (
                      <div key={d.k} title={`${d.k} · ${d.t} intrusion · ${d.f} firewall`} style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", height: "100%", gap: 2 }}>
                        {d.t > 0 && <span style={{ height: `${(d.t / dmax) * 56}px`, background: "var(--bad)", borderRadius: 3 }} />}
                        {d.f > 0 && <span style={{ height: `${(d.f / dmax) * 56}px`, background: "#8a6a2e", borderRadius: 3 }} />}
                      </div>
                    ))}
                  </div>
                  <div className="axis"><span>{days[0].k}</span><span>{days[days.length - 1].k}</span></div>
                </div>
              )}
              {(data.topSignatures?.length > 0 || data.topSources?.length > 0) && !ip && !rule && (
                <div className="grid g3">
                  {[["Top sources", data.topSources], ["Top targets", data.topTargets], ["Signatures & rules", [...(data.topSignatures || []), ...(data.topPolicies || [])].slice(0, 6)]].map(([title, rows]) => (
                    <div key={title} className="card tight">
                      <h2 style={{ fontSize: 14 }}>{title}</h2>
                      {(rows || []).slice(0, 5).map((r) => (
                        <div key={r.name} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13 }}>
                          <span className="ellipsis">{r.name}</span>
                          <span className="mono dim">{r.count}</span>
                        </div>
                      ))}
                      {!(rows || []).length && <span className="dim small">—</span>}
                    </div>
                  ))}
                </div>
              )}
              <div className="card" style={{ padding: "6px 10px" }}>
                <div className="rows">
                  {list.slice(0, 300).map((it) => (
                    <button
                      key={it.uid}
                      className={`row ${sel?.uid === it.uid ? "sel" : ""}`}
                      style={{ gridTemplateColumns: "130px 110px minmax(0, 1.2fr) minmax(0, 1fr)" }}
                      onClick={() => go("security", null, { ...route.query, e: it.uid })}
                    >
                      <span className="mono small dim">{shortDate(it.ts)}</span>
                      <span className={it.kind === "Threat blocked" ? "bad" : "warn"}>{it.kind === "Threat blocked" ? "Intrusion" : "Firewall"}</span>
                      <span className="stack">
                        <span className="ellipsis">{it.source || "—"} → {it.target || "—"}</span>
                        <span className="dim small ellipsis">{it.domain || (it.detail ? "" : Date.now() - it.ts > 4 * 86400000 ? "details older than 4 days" : "no connection details")}</span>
                      </span>
                      <span className="muted small ellipsis">{it.signature || it.policy || "—"}</span>
                    </button>
                  ))}
                  {!list.length && <div className="empty">Nothing blocked in this period.</div>}
                </div>
              </div>
              {bc && !ip && (
                <div className="card">
                  <div className="card-head" style={{ flexWrap: "wrap", gap: 10 }}>
                    <h2>Blocked by your rules</h2>
                    <span className="hint">
                      {bc.total.toLocaleString()} connections from UniFi's connection records — firewall rules and app / Object blocks, including those the list above never shows
                    </span>
                  </div>
                  {!rule && bc.rules.length > 0 && (
                    <div className="quick" role="group" aria-label="Rules">
                      <button className={`btn small ${connRule == null ? "on" : ""}`} onClick={() => setConnRule(null)}>All <span className="dim">{bc.total}</span></button>
                      {bc.rules.map((r) => (
                        <button key={ruleKey(r.rule)} className={`btn small ${connRule === ruleKey(r.rule) ? "on" : ""}`} onClick={() => setConnRule(connRule === ruleKey(r.rule) ? null : ruleKey(r.rule))}>
                          {r.rule || "rule not recorded"} <span className="dim">{r.n}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="rows">
                    {connRows.slice(0, 200).map((b, i) => (
                      <button
                        key={i}
                        className={`row ${route.query.bm === b.mac && route.query.bd === b.destination && (route.query.br || null) === b.rule ? "sel" : ""}`}
                        style={{ gridTemplateColumns: "130px minmax(0, 0.9fr) minmax(0, 1.2fr) minmax(0, 1fr) 60px" }}
                        onClick={() => go("security", null, { r: range, bm: b.mac, bd: b.destination, br: b.rule || null })}
                      >
                        <span className="mono small dim">{shortDate(b.last)}</span>
                        <span className="ellipsis" style={{ color: "var(--accent)" }}>{b.device}</span>
                        <span className="ellipsis small">{b.destination}{b.addresses > 1 ? <span className="dim"> · {b.addresses} addresses</span> : null}</span>
                        <span className="muted small ellipsis">{b.rule || "rule not recorded"}</span>
                        <span className="mono small" style={{ textAlign: "right" }}>×{b.n}</span>
                      </button>
                    ))}
                    {!connRows.length && <div className="empty">No blocked connections in this period.</div>}
                  </div>
                  {bc.truncated && <p className="dim small" style={{ margin: 0 }}>The 300 most recent groups.</p>}
                </div>
              )}
              {/* Ads and trackers stopped by UniFi's ad blocking (UU-C-150): a summary, not a list. */}
              {data.adBlocks?.total > 0 && !ip && !rule && (
                <div className="card">
                  <div className="card-head">
                    <h2>Ads &amp; trackers stopped</h2>
                    <span className="hint">{data.adBlocks.total.toLocaleString()} blocked by UniFi's ad blocking</span>
                  </div>
                  <div className="grid g2">
                    <div className="stack" style={{ gap: 4 }}>
                      <span className="dim small">By device</span>
                      {data.adBlocks.devices.slice(0, 10).map((d) => (
                        <div key={d.mac} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13 }}>
                          <a href={href("device", d.mac)} className="ellipsis">{d.device}</a>
                          <span className="mono dim">{d.n}</span>
                        </div>
                      ))}
                    </div>
                    <div className="stack" style={{ gap: 4 }}>
                      <span className="dim small">Top blocked addresses</span>
                      {data.adBlocks.domains.slice(0, 10).map((d) => (
                        <div key={d.domain} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13 }}>
                          <span className="ellipsis">{d.domain}{d.devices > 1 ? <span className="dim"> · {d.devices} devices</span> : null}</span>
                          <span className="mono dim">{d.n}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
              {hiddenCount > 0 && !ip && !rule && (
                <button className="btn small" style={{ alignSelf: "flex-start" }} onClick={() => setShowHidden((v) => !v)}>
                  {showHidden ? "Hide" : "Show"} {hiddenCount} event{hiddenCount === 1 ? "" : "s"} from hidden rules
                </button>
              )}
            </>
          )}
        </div>
      </div>
      {sel ? <Detail it={sel} all={all} onHide={toggleHide} hidden={hidden} /> : route.query.bm ? <BlockDetail key={`${route.query.bm}|${route.query.br}|${route.query.bd}`} q={{ ...route.query, r: range }} range={range} /> : null}
    </div>
  );
}
