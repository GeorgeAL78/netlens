import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ago, api, bytes, duration, href, isPlumbing, isUnnamed, kindLabel, kindSource, setPinned, shortDate, speed, useApi, usePins } from "../lib.js";
import { Failed, KindPicker, Loading } from "../ui.jsx";
import { Icon } from "../icons.jsx";

// Devices (UU-C-118, rebuilt in UU-C-293). Every client UniFi knows, made findable:
//   - "Needs you" tiles (new, failed Wi-Fi joins, weak signal, blocked, unnamed) filter the list;
//   - each row says what the device is (type icon, model or maker), where it is (access point
//     and signal, or switch port and speed) and what it did today (data and top app);
//   - online devices are grouped by where they connect, type or network; offline ones sit in
//     one section at the bottom, most recently seen first;
//   - VMs and containers fold under the device they run on, as on the Network map;
//   - one ⋯ menu per row (rename, type, pin, check, sites, apps, block), and a select mode to
//     act on several at once.
// Names are saved in UniFi itself, exactly as renaming the client in the UniFi app.

function vendorText(d) {
  if (d.vendor) return d.vendor;
  return d.privateMac ? "Private address — the device hides its maker" : "Unknown maker";
}
// What it is: UniFi's model name when it has one, else the maker.
const whatText = (d) => (d.type?.model && d.type.source !== "none" ? d.type.model : d.type?.source === "virtual" ? "Container — made-up network address" : vendorText(d));

// Where it is now (or was last): access point, band and signal, or switch, port and speed.
// Under a "where" group heading the access point or switch is already named, so it is left out.
function whereText(d, grouped = false) {
  const via = grouped && d.online ? null : d.via;
  if (d.wired) {
    const mbps = d.now?.rate ? Math.round(d.now.rate / 1000) : null;
    return [via || (grouped && d.online ? null : "Wired"), d.port != null ? `port ${d.port}` : null, d.online && mbps ? speed(mbps) : null].filter(Boolean).join(" · ") || "Wired";
  }
  return [via || (grouped && d.online ? null : "Wi-Fi"), d.now?.band || d.band].filter(Boolean).join(" · ") || "Wi-Fi";
}
const weak = (d) => d.online && !d.wired && d.now?.signal != null && d.now.signal < -75;
const topApp = (d) => (d.today?.apps || []).find((a) => !isPlumbing(a)) || d.today?.apps?.[0] || null;

// Cancel by button, Esc, or a click anywhere outside the box; only Save writes (UU-C-120).
function NameEditor({ d, onSaved, onCancel, autoFocus = false }) {
  const [name, setName] = useState(d.name || "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
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
    <form onSubmit={save} onKeyDown={(e) => e.key === "Escape" && onCancel?.()} className="dv-edit">
      <span className="dim small">Name</span>
      <input className="field" style={{ minWidth: 0, flex: "1 1 160px" }} value={name} placeholder="Give it a name" aria-label={`Name for ${d.label}`} autoFocus={autoFocus} onChange={(e) => setName(e.target.value)} />
      <button className="btn small primary" disabled={busy || name.trim() === (d.name || "")}>{busy ? "Saving…" : "Save"}</button>
      {onCancel && <button type="button" className="btn small" disabled={busy} onClick={onCancel}>Cancel</button>}
      {msg && <span className="bad small" role="alert" style={{ flexBasis: "100%" }}>{msg}</span>}
    </form>
  );
}

// UniFi says offline, but is it on the network? A ping, then a few common ports (UU-C-122).
const VERIFY = { match: "MAC verified", unknown: "address not verified", mismatch: "another device has its address" };
function CheckResult({ d, result }) {
  if (!result && d.presence && d.presence.state === "lan") return <span className="ok small" title={`${d.presence.method || ""} at ${d.presence.ip || d.ip}${d.presence.verify ? ` · ${VERIFY[d.presence.verify]}` : ""}`}>answers on the network</span>;
  if (!result && d.presence && d.presence.state === "off") return <span className="dim small" title={d.presence.method || ""}>{d.presence.verify === "mismatch" ? VERIFY.mismatch : "no answer"} · checked {ago(d.presence.checkedAt)}</span>;
  if (result === "checking") return <span className="dim small">checking…</span>;
  if (result?.error) return <span className="bad small" title={result.error}>check failed</span>;
  if (result) return result.up ? <span className="ok small" title={`Answered at ${d.ip}${result.verify ? ` · ${VERIFY[result.verify]}` : ""}`}>answers · {result.method}{result.ms != null ? ` ${result.ms} ms` : ""}</span> : <span className="dim small">{result.verify === "mismatch" ? VERIFY.mismatch : "no answer — off or asleep"}</span>;
  return null;
}

// One ⋯ menu per row; closes on a pick, Esc or a click elsewhere.
function RowMenu({ d, pinned, onAction }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const out = (e) => box.current && !box.current.contains(e.target) && setOpen(false);
    const esc = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", out);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", out);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const pick = (a) => () => {
    setOpen(false);
    onAction(a, d);
  };
  return (
    <span className="dv-menu" ref={box}>
      <button className="btn small quiet icon-only" aria-label={`Actions for ${d.label}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name="dots" size={16} />
      </button>
      {open && (
        <span className="dv-pop" role="menu">
          <a role="menuitem" href={href("device", d.mac)}>Open</a>
          <button role="menuitem" onClick={pick("name")}>{d.name ? "Rename" : "Name it"}</button>
          <button role="menuitem" onClick={pick("kind")}>Set type</button>
          <button role="menuitem" onClick={pick("pin")}>{pinned ? "Unpin from the sidebar" : "Pin to the sidebar"}</button>
          {!d.online && d.ip && <button role="menuitem" onClick={pick("check")}>Check on network</button>}
          <a role="menuitem" href={href("usage", null, { mac: d.mac })}>Apps today</a>
          <a role="menuitem" href={href("sites", null, { mac: d.mac })}>Sites</a>
          <button role="menuitem" className={d.blocked ? "" : "bad"} onClick={pick("block")}>{d.blocked ? "Unblock" : "Block"}</button>
        </span>
      )}
    </span>
  );
}

const GROUP_BY = [["where", "Where it connects"], ["type", "Type"], ["network", "Network"], ["none", "No groups"]];
const SORT_BY = [["name", "Name"], ["today", "Most data today"], ["seen", "Last seen"], ["first", "Newest first"]];
const JOIN_DAYS = [[1, "Today"], [7, "7 days"], [30, "30 days"], [90, "90 days"]];
const groupKey = (by, d) =>
  by === "where" ? (d.via ? `${d.wired ? "w" : "a"}|${d.via}` : "|Not placed") : by === "type" ? `|${kindLabel(d.type?.kind)}` : by === "network" ? `|${d.network || "Unknown network"}` : "|All online";
const remember = (k, v) => {
  try {
    localStorage.setItem(`netlens.devices.${k}`, v);
  } catch {
    /* private window */
  }
};
const recall = (k, fallback) => {
  try {
    return localStorage.getItem(`netlens.devices.${k}`) || fallback;
  } catch {
    return fallback;
  }
};

export default function Devices({ route }) {
  const { data, error, loading, reload } = useApi("/api/devices");
  const pins = usePins();
  const pinnedSet = useMemo(() => new Set((pins || []).map((p) => p.mac)), [pins]);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all"); // all | online | offline
  const [conn, setConn] = useState("any"); // any | wifi | wired
  const [onlyPinned, setOnlyPinned] = useState(false);
  const [focus, setFocus] = useState(null); // a "needs you" tile: new | joins | weak | blocked | unnamed
  const [groupBy, setGroupBy] = useState(() => recall("group", "where"));
  const [sortBy, setSortBy] = useState(() => recall("sort", "name"));
  const [showOffline, setShowOffline] = useState(false);
  const [showOld, setShowOld] = useState(false);
  const [openHosts, setOpenHosts] = useState(() => new Set());
  const [editing, setEditing] = useState(() => (route.query.mac ? new Map([[route.query.mac, "name"]]) : new Map())); // mac -> name | kind
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState(() => new Set());
  const [saved, setSaved] = useState({}); // names set this visit, shown before the reload lands
  const [kinds, setKinds] = useState({}); // types set this visit
  const [checks, setChecks] = useState({}); // mac -> "checking" | { up, method, ms } (UU-C-122)
  const [blockNow, setBlockNow] = useState({}); // mac -> blocked, before the reload lands (UU-C-135)
  const [msg, setMsg] = useState("");
  // Failed Wi-Fi joins (UU-C-146): the tile counts 7 days; its filter can look further back.
  const [joinDays, setJoinDays] = useState(7);
  const joins = useApi(`/api/wifi-joins?days=${joinDays}`);
  const joinsOf = useMemo(() => new Map((joins.data?.devices || []).filter((d) => d.fails).map((d) => [d.mac, d])), [joins.data]);

  const list = useMemo(
    () =>
      (data?.devices || [])
        .map((d) => (saved[d.mac] != null ? { ...d, name: saved[d.mac] || null, label: saved[d.mac] || d.hostname || d.mac } : d))
        .map((d) => (blockNow[d.mac] != null ? { ...d, blocked: blockNow[d.mac] } : d))
        .map((d) => (d.mac in kinds ? { ...d, type: kinds[d.mac] ? { ...d.type, kind: kinds[d.mac], source: "you" } : { ...d.type, source: "unifi" } } : d)),
    [data, saved, blockNow, kinds]
  );
  const old = (d) => !d.blocked && !d.online && isUnnamed({ name: d.name, mac: d.mac }) && (!d.lastSeen || Date.now() - d.lastSeen > 7 * 86400e3);
  const tiles = [
    { id: "new", n: list.filter((d) => d.isNew).length, label: (n) => `${n} new this week`, sub: (l) => { const u = l.filter((d) => isUnnamed(d)).length; return u ? `${u} without a name` : "all named"; }, test: (d) => d.isNew, warn: (l) => l.some((d) => isUnnamed(d)) },
    { id: "joins", n: list.filter((d) => joinsOf.has(d.mac)).length, label: (n) => `${n} failing to join Wi-Fi`, sub: (l) => l.slice(0, 2).map((d) => d.label).join(", "), test: (d) => joinsOf.has(d.mac), warn: () => true },
    { id: "weak", n: list.filter(weak).length, label: (n) => `${n} on a weak signal`, sub: () => "below −75 dBm now", test: weak, warn: () => true },
    { id: "blocked", n: list.filter((d) => d.blocked).length, label: (n) => `${n} blocked`, sub: () => "no network access", test: (d) => d.blocked, warn: () => false },
    { id: "unnamed", n: list.filter((d) => isUnnamed(d) && !old(d)).length, label: (n) => `${n} without a name`, sub: () => "seen this week", test: (d) => isUnnamed(d) && !old(d), warn: () => false },
  ].filter((t) => t.n > 0 || focus === t.id);
  const tile = tiles.find((t) => t.id === focus) || null;

  const s = q.trim().toLowerCase();
  const matches = (d) =>
    (!s || [d.label, d.name, d.hostname, d.mac, d.ip, d.vendor, d.via, d.type?.model, kindLabel(d.type?.kind), d.network].some((v) => String(v || "").toLowerCase().includes(s))) &&
    (!tile || tile.test(d)) &&
    (status === "all" || (status === "online") === Boolean(d.online)) &&
    (conn === "any" || (conn === "wired") === Boolean(d.wired)) &&
    (!onlyPinned || pinnedSet.has(d.mac));
  const shown = list.filter(matches);
  // VMs and containers fold under their host while it is shown and nothing is searched for.
  const shownMacs = new Set(shown.map((d) => d.mac));
  const folded = (d) => !s && !tile && d.host && shownMacs.has(d.host.mac);
  const guestsOf = new Map();
  for (const d of shown) if (folded(d)) guestsOf.set(d.host.mac, [...(guestsOf.get(d.host.mac) || []), d]);
  const top = shown.filter((d) => !folded(d));
  const maxToday = Math.max(1, ...top.map((d) => d.today?.bytes || 0));
  const order = (a, b) =>
    sortBy === "today" ? (b.today?.bytes || 0) - (a.today?.bytes || 0) || String(a.label).localeCompare(String(b.label))
      : sortBy === "seen" ? (b.lastSeen || 0) - (a.lastSeen || 0)
      : sortBy === "first" ? (b.firstSeen || 0) - (a.firstSeen || 0)
      : String(a.label).localeCompare(String(b.label));
  const online = top.filter((d) => d.online).sort(order);
  const offlineAll = top.filter((d) => !d.online).sort((a, b) => (sortBy === "name" || sortBy === "seen" ? (b.lastSeen || 0) - (a.lastSeen || 0) : order(a, b)));
  const hiddenOld = s || tile ? 0 : offlineAll.filter(old).length;
  const offline = s || tile || showOld ? offlineAll : offlineAll.filter((d) => !old(d));
  const offlineOpen = showOffline || status === "offline" || Boolean(s) || Boolean(tile) || !online.length;
  const groups = (() => {
    const m = new Map();
    for (const d of online) {
      const k = groupKey(groupBy, d);
      if (!m.has(k)) m.set(k, { key: k, label: k.slice(k.indexOf("|") + 1), wired: k.startsWith("w|"), wifi: k.startsWith("a|"), items: [], bytes: 0 });
      const g = m.get(k);
      g.items.push(d);
      g.bytes += (d.today?.bytes || 0) + (guestsOf.get(d.mac) || []).reduce((n, x) => n + (x.today?.bytes || 0), 0);
    }
    return [...m.values()].sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label));
  })();

  // Arrived from "Name it" / "Rename": bring that device into view with its name box open.
  useEffect(() => {
    if (!data || !route.query.mac) return;
    const d = list.find((x) => x.mac === route.query.mac);
    if (!d) return;
    if (!d.online) setShowOffline(true);
    if (old(d)) setShowOld(true);
    if (d.host) setOpenHosts((v) => new Set([...v, d.host.mac]));
    setTimeout(() => document.getElementById(`dev-${route.query.mac}`)?.scrollIntoView({ block: "center" }), 80);
  }, [data, route.query.mac]); // eslint-disable-line react-hooks/exhaustive-deps

  const edit = (mac, what) => setEditing((m) => new Map(m).set(mac, what));
  const stopEdit = (mac) => setEditing((m) => { const n = new Map(m); n.delete(mac); return n; });
  async function check(d) {
    setChecks((m) => ({ ...m, [d.mac]: "checking" }));
    try {
      const r = await api(`/api/devices/${encodeURIComponent(d.mac)}/probe`, { method: "POST" });
      setChecks((m) => ({ ...m, [d.mac]: r }));
    } catch (err) {
      setChecks((m) => ({ ...m, [d.mac]: { error: err.message || String(err) } }));
    }
  }
  async function checkAll(items) {
    const queue = items.filter((d) => !d.online && d.ip);
    const worker = async () => {
      while (queue.length) await check(queue.shift());
    };
    await Promise.all([worker(), worker(), worker(), worker()]); // four at a time
  }
  async function setBlock(items, next) {
    if (!items.length) return;
    const what = items.length === 1 ? items[0].label : `${items.length} devices`;
    if (!window.confirm(next ? `Block ${what}? ${items.length === 1 ? "It loses" : "They lose"} network access until you unblock ${items.length === 1 ? "it" : "them"}.` : `Unblock ${what}?`)) return;
    setMsg("");
    const done = [];
    for (const d of items) {
      try {
        const r = await api(`/api/clients/${encodeURIComponent(d.mac)}/block`, { method: "POST", body: JSON.stringify({ blocked: next }) });
        setBlockNow((m) => ({ ...m, [d.mac]: Boolean(r.blocked) }));
        done.push(d.label);
      } catch (err) {
        setMsg(`${d.label}: ${err.message || String(err)}`);
        return;
      }
    }
    setMsg(`${done.length === 1 ? done[0] : `${done.length} devices`} ${next ? "blocked" : "unblocked"} in UniFi.`);
  }
  function act(a, d) {
    if (a === "name" || a === "kind") edit(d.mac, a);
    else if (a === "pin") setPinned(d.mac, !pinnedSet.has(d.mac), d.label).catch((e) => setMsg(e.message));
    else if (a === "check") check(d);
    else if (a === "block") setBlock([d], !d.blocked);
  }
  const selected = list.filter((d) => sel.has(d.mac));
  const toggleSel = (mac) => setSel((v) => { const n = new Set(v); if (n.has(mac)) n.delete(mac); else n.add(mac); return n; });

  // A plain function, not a component: rows keep their name boxes across the page's re-renders.
  function row(d, guest = false) {
    const ed = editing.get(d.mac);
    const app = topApp(d);
    const kids = guestsOf.get(d.mac) || [];
    const open = openHosts.has(d.mac);
    const j = joinsOf.get(d.mac);
    return (
      <Fragment key={d.mac}>
        <div id={`dev-${d.mac}`} className={`row dv-row ${selecting ? "selecting" : ""} ${guest ? "guest" : ""} ${route.query.mac === d.mac ? "sel" : ""} ${d.online ? "" : "is-off"}`}>
          {selecting && <input type="checkbox" className="dv-check" checked={sel.has(d.mac)} onChange={() => toggleSel(d.mac)} aria-label={`Select ${d.label}`} />}
          <span className={`dv-icon ${d.online ? "" : "off"}`} title={`${kindLabel(d.type?.kind)} · ${kindSource(d.type)}`}>
            <Icon name={d.type?.kind || "other"} size={20} />
            <span className={`status-dot ${d.online ? "" : d.presence?.state === "lan" ? "warn" : "off"}`} />
          </span>
          <span className="stack dv-name">
            <span className="ellipsis">
              <a href={href("device", d.mac)}>{d.label}</a>
              {pinnedSet.has(d.mac) && <span className="dv-star" title="Pinned to the sidebar">★</span>}
              {d.isNew && <span className="dv-flag">new</span>}
              {d.blocked && <span className="dv-flag bad">blocked</span>}
              {j && <span className="dv-flag warn" title={j.problems.map((p) => `${p.label} ×${p.n}`).join(" · ")}>{j.fails} failed join{j.fails === 1 ? "" : "s"}</span>}
            </span>
            <span className="dim small ellipsis" title={vendorText(d)}>{whatText(d)}</span>
          </span>
          <span className="stack dv-where">
            <span className="small ellipsis">{d.online ? "" : <span className="dim">last on </span>}{whereText(d, groupBy === "where" && !guest)}</span>
            <span className="dim small ellipsis">
              {d.online && !d.wired && d.now?.signal != null ? <span className={d.now.signal < -80 ? "bad" : d.now.signal < -75 ? "warn" : ""}>{d.now.signal} dBm</span> : null}
              {d.online && !d.wired && d.now?.signal != null && d.ip ? " · " : ""}
              <span className="mono">{d.ip || d.mac}</span>
            </span>
          </span>
          <span className="stack dv-today">
            {d.today?.bytes ? (
              <>
                <span className="meter" title={`today: ↓ ${bytes(d.today.down)} ↑ ${bytes(d.today.up)}`}><span style={{ width: `${Math.max(2, Math.round((100 * d.today.bytes) / maxToday))}%` }} /></span>
                <span className="small ellipsis"><span className="mono">{bytes(d.today.bytes)}</span>{app ? <span className="dim"> · {app.app}{app.seconds >= 300 && !isPlumbing(app) ? ` ${duration(app.seconds)}` : ""}</span> : null}</span>
              </>
            ) : (
              <span className="dim small">{d.online ? "nothing counted today" : "—"}</span>
            )}
          </span>
          <span className={`stack dv-seen ${d.online && !kids.length ? "quiet" : ""}`}>
            <span className="dim small">{d.online ? "online" : d.lastSeen ? `seen ${ago(d.lastSeen)}` : "never seen"}</span>
            {!d.online && <CheckResult d={d} result={checks[d.mac]} />}
            {kids.length > 0 && (
              <button className="linkish small" aria-expanded={open} onClick={() => setOpenHosts((v) => { const n = new Set(v); if (n.has(d.mac)) n.delete(d.mac); else n.add(d.mac); return n; })}>
                {open ? "hide" : "+"} {kids.length} {kids.every((k) => k.type?.kind === "vm" && /container/.test(k.type?.model || "")) ? "containers" : "VMs / containers"}
              </button>
            )}
          </span>
          <RowMenu d={d} pinned={pinnedSet.has(d.mac)} onAction={act} />
        </div>
        {ed === "name" && (
          <div className="dv-extra">
            <NameEditor d={d} autoFocus onSaved={(name) => { setSaved((m) => ({ ...m, [d.mac]: name })); stopEdit(d.mac); reload(); }} onCancel={() => stopEdit(d.mac)} />
          </div>
        )}
        {ed === "kind" && (
          <div className="dv-extra">
            <KindPicker d={d} onSaved={(k) => setKinds((m) => ({ ...m, [d.mac]: k }))} onCancel={() => stopEdit(d.mac)} />
          </div>
        )}
        {open && kids.map((g) => row(g, true))}
      </Fragment>
    );
  }

  const onlineCount = list.filter((d) => d.online).length;
  const todayTotal = list.reduce((n, d) => n + (d.today?.bytes || 0), 0);
  return (
    <div className="page">
      <div className="page-head">
        <div className="titles">
          <span className="dim small">Devices</span>
          <h1>Your devices</h1>
          {data && (
            <span className="muted">
              {data.source === "stored" ? `UniFi did not answer — ${list.length} devices NetLens has stored` : `${list.length} known`} · {onlineCount} online
              {list.some((d) => !d.online && d.presence?.state === "lan") ? ` · ${list.filter((d) => !d.online && d.presence?.state === "lan").length} more answer on the network` : ""}
              {todayTotal ? ` · ${bytes(todayTotal)} today` : ""}
              {data.checks?.lastRunAt ? ` · offline devices checked ${ago(data.checks.lastRunAt)}` : ""}
            </span>
          )}
        </div>
      </div>
      {error && <Failed error={error} reload={reload} />}
      {!data && loading && <Loading what="Asking UniFi for its device list…" />}
      {msg && <p className="note">{msg}</p>}
      {data && (
        <>
          {tiles.length > 0 && (
            <div className="dv-tiles" role="group" aria-label="Needs you">
              {tiles.map((t) => {
                const items = list.filter(t.test);
                return (
                  <button key={t.id} className={`dv-tile ${t.warn(items) ? "warn" : ""} ${focus === t.id ? "on" : ""}`} aria-pressed={focus === t.id} onClick={() => setFocus(focus === t.id ? null : t.id)}>
                    <span className="dv-tile-n">{t.label(items.length)}</span>
                    <span className="dim small ellipsis">{t.sub(items)}</span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="card dv-card">
            <div className="dv-tools">
              <div className="seg" role="group" aria-label="Online or offline">
                {[["all", `All ${list.length}`], ["online", `Online ${onlineCount}`], ["offline", `Offline ${list.length - onlineCount}`]].map(([id, label]) => (
                  <button key={id} className={status === id ? "on" : ""} aria-pressed={status === id} onClick={() => setStatus(id)}>{label}</button>
                ))}
              </div>
              <div className="seg" role="group" aria-label="Connection">
                {[["any", "Any"], ["wifi", "Wi-Fi"], ["wired", "Wired"]].map(([id, label]) => (
                  <button key={id} className={conn === id ? "on" : ""} aria-pressed={conn === id} onClick={() => setConn(id)}>{label}</button>
                ))}
              </div>
              {pinnedSet.size > 0 && (
                <button className={`btn small pin ${onlyPinned ? "on" : ""}`} aria-pressed={onlyPinned} onClick={() => setOnlyPinned((v) => !v)}>★ Pinned</button>
              )}
              <input className="field dv-search" placeholder="Search name, IP, MAC, maker, type" aria-label="Search devices" value={q} onChange={(e) => setQ(e.target.value)} />
              <select className="field" value={groupBy} aria-label="Group by" onChange={(e) => { setGroupBy(e.target.value); remember("group", e.target.value); }}>
                {GROUP_BY.map(([id, label]) => <option key={id} value={id}>Group: {label.toLowerCase()}</option>)}
              </select>
              <select className="field" value={sortBy} aria-label="Sort by" onChange={(e) => { setSortBy(e.target.value); remember("sort", e.target.value); }}>
                {SORT_BY.map(([id, label]) => <option key={id} value={id}>Sort: {label.toLowerCase()}</option>)}
              </select>
              <button className={`btn small ${selecting ? "on" : ""}`} aria-pressed={selecting} onClick={() => { setSelecting((v) => !v); setSel(new Set()); }}>{selecting ? "Done" : "Select"}</button>
            </div>

            {tile && (
              <div className="dv-focus">
                <span className="small">Showing: <strong>{tile.label(list.filter(tile.test).length)}</strong></span>
                {focus === "joins" && (
                  <div className="seg" role="group" aria-label="Period">
                    {JOIN_DAYS.map(([n, label]) => <button key={n} className={joinDays === n ? "on" : ""} onClick={() => setJoinDays(n)}>{label}</button>)}
                  </div>
                )}
                <button className="linkish small" onClick={() => setFocus(null)}>Show every device</button>
              </div>
            )}
            {focus === "joins" && (
              <div className="rows">
                {[...joinsOf.values()].flatMap((d) =>
                  d.problems.map((p) => (
                    <div key={`${d.mac}-${p.key}`} className="row dev-stack" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.4fr) auto", cursor: "default", alignItems: "center" }}>
                      <span className="stack">
                        <a href={href("device", d.mac, { tab: "connection" })} className="ellipsis">{d.name}</a>
                        <span className="dim small">{d.joins} joined · {d.fails} failed{d.lastFail ? ` · last ${shortDate(d.lastFail)}` : ""}</span>
                      </span>
                      <span className="stack">
                        <span className="small"><span className="warn">{p.label}</span> <span className="dim">×{p.n} · {p.aps.map((a) => a.name).join(", ")}</span></span>
                        {p.hint && <span className="dim small">{p.hint}</span>}
                      </span>
                      <span className="mono warn">{p.n}</span>
                    </div>
                  ))
                )}
              </div>
            )}

            {selecting && (
              <div className="dv-bulk">
                <span className="small"><strong>{selected.length}</strong> selected</span>
                <button className="linkish small" onClick={() => setSel(new Set(shown.map((d) => d.mac)))}>select all {shown.length} shown</button>
                {selected.length > 0 && (
                  <>
                    <button className="btn small" onClick={() => selected.forEach((d) => edit(d.mac, "name"))}>Name them</button>
                    {selected.some((d) => !d.online && d.ip) && <button className="btn small" onClick={() => checkAll(selected)}>Check on network</button>}
                    <button className="btn small" onClick={() => selected.forEach((d) => !pinnedSet.has(d.mac) && setPinned(d.mac, true, d.label).catch((e) => setMsg(e.message)))}>Pin</button>
                    {selected.some((d) => d.blocked) && <button className="btn small" onClick={() => setBlock(selected.filter((d) => d.blocked), false)}>Unblock</button>}
                    {selected.some((d) => !d.blocked) && <button className="btn small danger" onClick={() => setBlock(selected.filter((d) => !d.blocked), true)}>Block</button>}
                  </>
                )}
              </div>
            )}

            {!shown.length && <div className="empty">{s ? `No device matches “${q}”.` : "No device fits these filters."}</div>}

            {status !== "offline" &&
              groups.map((g) => (
                <section key={g.key} className="dv-group">
                  {groupBy !== "none" && (
                    <h3 className="dv-group-head">
                      <span className="dv-group-name">
                        {groupBy === "where" && <Icon name={g.wifi ? "wifi" : g.wired ? "map" : "other"} size={15} />}
                        {groupBy === "where" && g.label !== "Not placed" ? <a href={href("network")}>{g.label}</a> : g.label}
                      </span>
                      <span className="dim small">{g.items.length} online{g.bytes ? ` · ${bytes(g.bytes)} today` : ""}</span>
                    </h3>
                  )}
                  <div className="rows">{g.items.map((d) => row(d))}</div>
                </section>
              ))}

            {status !== "online" && offline.length + hiddenOld > 0 && (
              <section className="dv-group">
                <h3 className="dv-group-head">
                  <button className="linkish dv-group-name" aria-expanded={offlineOpen} onClick={() => setShowOffline((v) => !v)}>
                    <span className={`dv-chev ${offlineOpen ? "open" : ""}`}><Icon name="chevron" size={14} /></span> Offline · {offline.length}
                  </button>
                  <span className="dim small">most recently seen first</span>
                  {offlineOpen && offline.some((d) => d.ip) && (
                    <button className="btn small" style={{ marginLeft: "auto" }} onClick={() => checkAll(offline)} title="Ping or knock on every offline device in this list">Check them all</button>
                  )}
                </h3>
                {offlineOpen && <div className="rows">{offline.map((d) => row(d))}</div>}
                {offlineOpen && hiddenOld > 0 && (
                  <button className="btn small" style={{ alignSelf: "flex-start" }} onClick={() => setShowOld((v) => !v)}>
                    {showOld ? "Hide" : "Show"} {hiddenOld} old unnamed address{hiddenOld === 1 ? "" : "es"}
                  </button>
                )}
              </section>
            )}
          </div>
        </>
      )}
    </div>
  );
}
