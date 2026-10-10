import { useEffect, useMemo, useRef, useState } from "react";
import { ago, api, href, isUnnamed, useApi } from "../lib.js";
import { Failed, Loading } from "../ui.jsx";

// Devices (UU-C-118): every client UniFi knows — new ones first, with vendor and where they
// showed up — and a name you can set. Names are saved in UniFi itself, exactly as renaming
// the client in the UniFi app, so they show everywhere.

function where(d) {
  if (d.wired) return `Wired · ${d.via || "switch"}${d.port != null ? ` port ${d.port}` : ""}`;
  return `Wi-Fi · ${d.via || "access point"}${d.band ? ` · ${d.band}` : ""}`;
}

function vendorText(d) {
  if (d.vendor) return d.vendor;
  return d.privateMac ? "Private address — the device hides its maker" : "Unknown maker";
}

// Cancel by button, Esc, or a click anywhere outside the box; only Save writes (UU-C-120).
function NameEditor({ d, onSaved, onCancel, autoFocus = false }) {
  const [name, setName] = useState(d.name || "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const box = useRef(null);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  useEffect(() => {
    const out = (e) => box.current && !box.current.contains(e.target) && cancel.current?.();
    const t = setTimeout(() => document.addEventListener("mousedown", out), 0); // not the opening click
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", out);
    };
  }, []);
  async function save(e) {
    e?.preventDefault();
    setBusy(true);
    setMsg("");
    try {
      await api(`/api/devices/${encodeURIComponent(d.mac)}/name`, { method: "POST", body: JSON.stringify({ name }) });
      onSaved(name.trim());
    } catch (err) {
      setMsg(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form ref={box} onSubmit={save} onKeyDown={(e) => e.key === "Escape" && onCancel?.()} style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
      <input className="field" style={{ minWidth: 0, flex: "1 1 160px" }} value={name} placeholder="Give it a name" aria-label={`Name for ${d.label}`} autoFocus={autoFocus} onChange={(e) => setName(e.target.value)} />
      <button className="btn small primary" disabled={busy || name.trim() === (d.name || "")}>{busy ? "Saving…" : "Save"}</button>
      {onCancel && (
        <button type="button" className="btn small" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      )}
      {msg && <span className="bad small" role="alert" style={{ flexBasis: "100%" }}>{msg}</span>}
    </form>
  );
}

// UniFi says offline, but is it on the network? A ping, then a few common ports (UU-C-122).
function CheckResult({ d, result, onCheck }) {
  if (!d.ip) return null;
  if (result === "checking") return <span className="dim small">checking…</span>;
  if (result?.error) return <span className="bad small" title={result.error}>check failed</span>;
  if (result)
    return result.up ? (
      <span className="ok small" title={`Answered at ${d.ip}`}>answers on the network · {result.method}{result.ms != null ? ` ${result.ms} ms` : ""}</span>
    ) : (
      <span className="dim small" title={`No answer at ${d.ip}`}>no answer — off or asleep</span>
    );
  return (
    <button className="linkish small" onClick={onCheck}>
      Check on network
    </button>
  );
}

export default function Devices({ route }) {
  const { data, error, loading, reload } = useApi("/api/devices");
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState(route.query.mac ? `all:${route.query.mac}` : null); // "new:<mac>" or "all:<mac>"
  const [showOld, setShowOld] = useState(false);
  const [saved, setSaved] = useState({}); // names set this visit, shown before the reload lands
  // Network checks (UU-C-122): mac -> "checking" | { up, method, ms }.
  const [checks, setChecks] = useState({});
  const [checkingAll, setCheckingAll] = useState(false);
  async function check(d) {
    setChecks((m) => ({ ...m, [d.mac]: "checking" }));
    try {
      const r = await api(`/api/devices/${encodeURIComponent(d.mac)}/probe`, { method: "POST" });
      setChecks((m) => ({ ...m, [d.mac]: r }));
    } catch (err) {
      setChecks((m) => ({ ...m, [d.mac]: { error: err.message || String(err) } }));
    }
  }
  async function checkAll(list) {
    setCheckingAll(true);
    const queue = list.filter((d) => !d.online && d.ip);
    const worker = async () => {
      while (queue.length) await check(queue.shift());
    };
    await Promise.all([worker(), worker(), worker(), worker()]); // four at a time
    setCheckingAll(false);
  }

  const list = useMemo(() => (data?.devices || []).map((d) => (saved[d.mac] != null ? { ...d, name: saved[d.mac] || null, label: saved[d.mac] || d.hostname || d.mac } : d)), [data, saved]);
  const fresh = list.filter((d) => d.isNew);
  const old = (d) => !d.online && isUnnamed({ name: d.name, mac: d.mac }) && (!d.lastSeen || Date.now() - d.lastSeen > 7 * 86400e3);
  const hiddenOld = list.filter(old).length;
  const s = q.trim().toLowerCase();
  const all = list
    .filter((d) => showOld || s || !old(d))
    .filter((d) => !s || [d.label, d.name, d.hostname, d.mac, d.ip, d.vendor, d.via].some((v) => String(v || "").toLowerCase().includes(s)))
    .sort((a, b) => Number(b.online) - Number(a.online) || String(a.label).localeCompare(String(b.label)));
  // Arrived from "Name it" / "Rename": bring that device into view with its name box open.
  useEffect(() => {
    if (!data || !route.query.mac) return;
    if (list.some((d) => d.mac === route.query.mac && old(d))) setShowOld(true);
    setTimeout(() => document.getElementById(`dev-${route.query.mac}`)?.scrollIntoView({ block: "center" }), 50);
  }, [data, route.query.mac]); // eslint-disable-line react-hooks/exhaustive-deps
  const onSaved = (d) => (name) => {
    setSaved((m) => ({ ...m, [d.mac]: name }));
    setEditing(null);
    reload();
  };

  return (
    <div className="page">
      <div className="page-head">
        <div className="titles">
          <span className="dim small">Devices</span>
          <h1>Your devices</h1>
          {data && (
            <span className="muted">
              {list.length} known to UniFi · {list.filter((d) => d.online).length} online now · names are saved in UniFi
            </span>
          )}
        </div>
      </div>
      {error && <Failed error={error} reload={reload} />}
      {!data && loading && <Loading what="Asking UniFi for its device list…" />}
      {data && (
        <>
          <div className="card">
            <div className="card-head">
              <h2>New in the last 7 days</h2>
            </div>
            {!fresh.length && <div className="empty">No new devices this week.</div>}
            <div className="rows">
              {fresh.map((d) => (
                <div key={d.mac} className="row" style={{ gridTemplateColumns: "minmax(0, 1.2fr) minmax(0, 1fr) minmax(150px, auto)", cursor: "default", alignItems: "center" }}>
                  <span className="stack">
                    <a href={href("device", d.mac)} className="ellipsis">{d.label}</a>
                    <span className="dim small ellipsis">{vendorText(d)}</span>
                  </span>
                  <span className="stack">
                    <span className="small ellipsis">{where(d)}</span>
                    <span className="dim small">first seen {ago(d.firstSeen)}{d.ip ? ` · ${d.ip}` : ""}{d.online ? " · online" : ""}</span>
                  </span>
                  {editing === `new:${d.mac}` ? (
                    <NameEditor d={d} onSaved={onSaved(d)} onCancel={() => setEditing(null)} autoFocus />
                  ) : (
                    <button className="btn small" style={{ justifySelf: "end" }} onClick={() => setEditing(`new:${d.mac}`)}>
                      {d.name ? "Rename" : "Name it"}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-head" style={{ gap: 12, flexWrap: "wrap" }}>
              <h2>All devices</h2>
              <button className="btn small" disabled={checkingAll} onClick={() => checkAll(all)} title="Ping or knock on every offline device in this list">
                {checkingAll ? "Checking…" : "Check offline devices"}
              </button>
              <input className="field" style={{ marginLeft: "auto", minWidth: 220 }} placeholder="Search name, IP, MAC, maker" aria-label="Search devices" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="rows">
              {all.map((d) => (
                <div key={d.mac} id={`dev-${d.mac}`} className={`row ${route.query.mac === d.mac ? "sel" : ""}`} style={{ gridTemplateColumns: "14px minmax(0, 1.2fr) minmax(0, 1fr) 170px minmax(150px, auto)", cursor: "default", alignItems: "center" }}>
                  <span className={`status-dot ${d.online ? "" : "off"}`} title={d.online ? "online" : "offline"} />
                  <span className="stack">
                    <a href={href("device", d.mac)} className="ellipsis">{d.label}</a>
                    <span className="dim small ellipsis">{vendorText(d)}</span>
                  </span>
                  <span className="stack">
                    <span className="small ellipsis">{where(d)}</span>
                    <span className="dim small mono ellipsis">{d.ip || d.mac}</span>
                  </span>
                  <span className="stack" style={{ gap: 2 }}>
                    <span className="dim small">{d.online ? "online now" : d.lastSeen ? `seen ${ago(d.lastSeen)}` : "—"}</span>
                    {!d.online && <CheckResult d={d} result={checks[d.mac]} onCheck={() => check(d)} />}
                  </span>
                  {editing === `all:${d.mac}` ? (
                    <NameEditor d={d} onSaved={onSaved(d)} onCancel={() => setEditing(null)} autoFocus />
                  ) : (
                    <button className="btn small" style={{ justifySelf: "end" }} onClick={() => setEditing(`all:${d.mac}`)}>
                      {d.name ? "Rename" : "Name it"}
                    </button>
                  )}
                </div>
              ))}
              {!all.length && <div className="empty">No device matches “{q}”.</div>}
            </div>
            {hiddenOld > 0 && !s && (
              <button className="btn small" style={{ alignSelf: "flex-start" }} onClick={() => setShowOld((v) => !v)}>
                {showOld ? "Hide" : "Show"} {hiddenOld} old unnamed address{hiddenOld === 1 ? "" : "es"}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
