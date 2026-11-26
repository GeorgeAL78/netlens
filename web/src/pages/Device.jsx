import { useEffect, useMemo, useRef, useState } from "react";

import { api, bytes, clock, duration, go, href, rate, shortDate, speed, todayKey, useApi, sessionDetail, splitTip, setPinned, usePins, kindLabel, kindSource } from "../lib.js";
import { DayStep, Failed, KindPicker, Loading, Meter, Bytes, Split } from "../ui.jsx";
import { Icon } from "../icons.jsx";

// One device (UU-C-087): its day — traffic, signal and events by hour — its connection,
// apps, sessions and events, and blocking. Everything links back to the hour or event.
// In tabs since UU-C-293 (`?tab=`): Summary (the tiles, what stands out, its day, top apps and
// the latest events), Apps and events, Connection (joins, Wi-Fi history or ports, runs on), and
// Online history. Nothing was dropped: each card moved to one tab.

const HOUR = 3600000;
const BAND = { ng: "2.4 GHz", na: "5 GHz", "6e": "6 GHz", "6 GHz": "6 GHz", "5 GHz": "5 GHz", "2.4 GHz": "2.4 GHz" };
const sigColor = (s) => (s == null ? "var(--cell-0)" : s < -80 ? "var(--sig-bad)" : s < -75 ? "var(--sig-weak)" : "var(--sig-good)");

function csv(rows) {
  return rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
}

// Which device a VM / container runs on (UU-C-165): detected, or chosen here.
function RunsOn({ mac, list }) {
  const info = useApi(`/api/devices/${encodeURIComponent(mac)}/host`);
  const [msg, setMsg] = useState("");
  const d = info.data;
  if (!d || (!d.guest && !d.choice && !d.host && !d.guests.length)) return null;
  const hosts = (list.data?.devices || []).filter((x) => x.wired && !x.privateMac && x.mac !== mac).sort((a, b) => String(a.label).localeCompare(String(b.label)));
  async function choose(v) {
    setMsg("");
    try {
      await api(`/api/devices/${encodeURIComponent(mac)}/host`, { method: "POST", body: JSON.stringify({ host: v || null }) });
      setMsg("Saved — the Network map uses it from now on.");
      info.reload();
    } catch (err) {
      setMsg(err.message || String(err));
    }
  }
  return (
    <div className="card">
      <div className="card-head">
        <h2>{d.guests.length ? "Runs" : "Runs on"}</h2>
        {d.guest && <span className="dim small">{d.guest.kind === "vm" ? `virtual machine${d.guest.platform ? ` · ${d.guest.platform}` : ""}` : "container (made-up network address)"}</span>}
      </div>
      {d.guests.length > 0 && <p className="small" style={{ margin: 0 }}>{d.guests.map((g) => g.name).join(", ")}</p>}
      {(d.guest || d.choice) && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
          <select className="field" value={d.choice || ""} onChange={(e) => choose(e.target.value)} aria-label="Runs on">
            <option value="">Automatic{d.host && !d.choice ? ` — ${d.host.name}${d.host.how === "presence" ? " (probably)" : ""}` : !d.choice ? " — not placed" : ""}</option>
            {hosts.map((h) => <option key={h.mac} value={h.mac}>Runs on {h.label}</option>)}
            <option value="none">Not a VM or container</option>
          </select>
          {d.host?.note && !d.choice && <span className="dim small">{d.host.note}</span>}
          {!d.grouping && <span className="dim small">Grouping is off in Settings.</span>}
        </div>
      )}
      {msg && <p className="dim small" style={{ margin: 0 }}>{msg}</p>}
    </div>
  );
}

// Where traffic UniFi could not name went (UU-C-287), from the connection records: the owners
// of the addresses. Named only when one owner has most of it (REVIEW rule 24).
const topOwner = (u) => {
  const t = u?.owners?.[0];
  return t && t.owner && t.share >= 70 ? t.owner : null;
};
function UnnamedTo({ u }) {
  const shown = u.owners.filter((o) => o.share >= 1).slice(0, 3);
  return (
    <span className="dim small" title="UniFi's counters cannot tell what this was; its connection records say where it went, by who owns the addresses">
      Went to {shown.map((o, i) => <span key={i}>{i ? " · " : ""}{o.owner || "unknown addresses"} {o.share}%</span>)} (connection records)
    </span>
  );
}

// A Wi-Fi device's connects, roams and disconnects (UU-C-286): UniFi's log, plus moves NetLens's
// 5-minute samples saw that the log did not. Newest first, by day.
const HISTORY_DAYS = [[1, "24 hours"], [7, "7 days"], [30, "30 days"]];
const dur = (ms) => (ms >= 86400e3 ? `${Math.floor(ms / 86400e3)}d ${Math.round((ms % 86400e3) / 3600e3)}h` : ms >= 3600e3 ? `${Math.floor(ms / 3600e3)}h ${Math.round((ms % 3600e3) / 60e3)}m` : `${Math.max(1, Math.round(ms / 60e3))}m`);
const sig = (v) => (v == null ? "" : `${v} dBm`);
function WifiHistory({ mac }) {
  const [days, setDays] = useState(7);
  const [only, setOnly] = useState("all");
  const { data: h } = useApi(`/api/devices/${encodeURIComponent(mac)}/wifi-history?days=${days}`);
  if (!h) return null;
  const list = h.events.filter((e) => only === "all" || (only === "roams" ? e.kind === "roam" || e.kind === "band" : e.kind === "connect" || e.kind === "disconnect"));
  const byDay = [];
  for (const e of list) {
    const k = new Date(e.ts).toDateString();
    if (!byDay.length || byDay[byDay.length - 1].k !== k) byDay.push({ k, ts: e.ts, items: [] });
    byDay[byDay.length - 1].items.push(e);
  }
  const where = (ap, band, ch, s) => [ap, band, ch ? `ch ${ch}` : null, sig(s)].filter(Boolean).join(" · ");
  return (
    <div className="card">
      <div className="card-head">
        <h2>Wi-Fi history</h2>
        <span className="dim small">
          {h.counts.roams} roam{h.counts.roams === 1 ? "" : "s"}{h.counts.bandChanges ? ` · ${h.counts.bandChanges} band change${h.counts.bandChanges === 1 ? "" : "s"}` : ""} · {h.counts.connects} connect{h.counts.connects === 1 ? "" : "s"} · {h.counts.disconnects} disconnect{h.counts.disconnects === 1 ? "" : "s"}
        </span>
        <div className="seg end" role="group" aria-label="Period">
          {HISTORY_DAYS.map(([n, label]) => <button key={n} className={days === n ? "on" : ""} aria-pressed={days === n} onClick={() => setDays(n)}>{label}</button>)}
        </div>
      </div>
      {h.where.length > 0 && (
        <p className="small" style={{ margin: 0 }}>
          <span className="dim">Time on each access point: </span>
          {h.where.slice(0, 4).map((x, i) => <span key={i}>{i ? " · " : ""}{x.ap}{x.band ? <span className="dim"> {x.band}</span> : null} {x.share}%</span>)}
        </p>
      )}
      <div className="seg" role="group" aria-label="Show" style={{ alignSelf: "flex-start" }}>
        {[["all", "Everything"], ["roams", "Roams"], ["connects", "Connects"]].map(([id, label]) => <button key={id} className={only === id ? "on" : ""} aria-pressed={only === id} onClick={() => setOnly(id)}>{label}</button>)}
      </div>
      {!list.length && <span className="dim small">{only === "roams" ? "No roams: it stayed on one access point and band." : "Nothing recorded."}</span>}
      {byDay.map((d) => (
        <div key={d.k}>
          <h3 className="small dim" style={{ margin: "6px 0 2px" }}>{shortDate(d.ts).replace(/,? \d{1,2}:\d{2}.*$/, "")}</h3>
          <div className="rows">
            {d.items.map((e, i) => (
              <div key={i} className="row wh-row" style={{ gridTemplateColumns: "72px 110px minmax(0, 1fr)", cursor: "default" }}>
                <span className="mono small dim">{clock(e.ts)}</span>
                <span className={`small ${e.kind === "disconnect" ? "dim" : e.kind === "roam" || e.kind === "band" ? "" : "ok"}`}>
                  {{ connect: "Connected", disconnect: "Disconnected", roam: "Roamed", band: "Changed band" }[e.kind]}
                </span>
                <span className="small">
                  {e.kind === "roam" || e.kind === "band" ? (
                    <>{where(e.from, e.fromBand, e.fromChannel, e.fromSignal)} <span className="dim">→</span> {where(e.ap, e.band, e.channel, e.signal)}</>
                  ) : e.kind === "disconnect" ? (
                    <>from {where(e.ap, e.band, null, e.signal)}{e.connectedMs ? <span className="dim"> · after {dur(e.connectedMs)}</span> : null}{e.why ? <span className={e.why.own ? "dim" : "warn"} title={e.why.code != null ? `802.11 reason ${e.why.code}: ${e.why.why}` : undefined}> · {e.why.text}{e.why.rssi != null ? ` at ${e.why.rssi} dBm` : ""}</span> : null}</>
                  ) : (
                    <>to {where(e.ap, e.band, e.channel, e.signal)}</>
                  )}
                  {e.source === "samples" ? <span className="dim" title="Not in UniFi's log: NetLens's 5-minute samples saw the move"> · seen in samples</span> : null}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
      {h.more > 0 && <span className="dim small">and {h.more} older</span>}
    </div>
  );
}

// Wi-Fi problems from the access points' own logs (UU-C-299): DNS timeouts, the anomalies the
// access point flags for this device, and how often it left or was removed.
function WifiProblems({ mac }) {
  const [days, setDays] = useState(7);
  const { data: p } = useApi(`/api/devices/${encodeURIComponent(mac)}/wifi-problems?days=${days}`);
  if (!p) return null;
  const removed = p.leaves.filter((l) => !l.own);
  const nothing = !p.dns.events && !p.anomalies.length && !p.leaves.length && !p.recent.length;
  return (
    <div className="card">
      <div className="card-head">
        <h2>Wi-Fi problems</h2>
        <span className="dim small">from the access points' own log</span>
        <div className="seg end" role="group" aria-label="Period">
          {HISTORY_DAYS.map(([n, label]) => <button key={n} className={days === n ? "on" : ""} aria-pressed={days === n} onClick={() => setDays(n)}>{label}</button>)}
        </div>
      </div>
      {nothing && <span className="dim small">Nothing flagged. (This needs UniFi's Access Points device log sent to NetLens: Activity Logging › SIEM Server › Devices.)</span>}
      {!nothing && (
        <div className="facts">
          <div className="fact">
            <span className="label">DNS timeouts</span>
            <span className={p.dns.timeouts ? "warn" : ""}>{p.dns.timeouts ? `${p.dns.timeouts} lookups, ${p.dns.events} time${p.dns.events === 1 ? "" : "s"}` : "None"}</span>
            {p.dns.last ? <span className="small dim">last {shortDate(p.dns.last)}{p.dns.aps.length ? ` · ${p.dns.aps.join(", ")}` : ""}</span> : null}
          </div>
          {p.anomalies.map((a) => (
            <div key={a.key} className="fact">
              <span className="label">Flagged: {a.label}</span>
              <span className="warn">{a.n} time{a.n === 1 ? "" : "s"}</span>
              <span className="small dim">{[a.signal != null ? `signal around ${a.signal} dBm` : null, a.satisfaction != null ? `satisfaction down to ${a.satisfaction}%` : null, `last ${shortDate(a.last)}`].filter(Boolean).join(" · ")}</span>
            </div>
          ))}
          <div className="fact">
            <span className="label">Left Wi-Fi</span>
            <span>{p.leaves.length ? `${p.leaves.length} time${p.leaves.length === 1 ? "" : "s"}` : "None recorded"}</span>
            {p.leaves.length > 0 && <span className={`small ${removed.length ? "warn" : "dim"}`}>{removed.length ? `${removed.length} removed by the access point (${[...new Set(removed.map((l) => l.why))].join(", ")})` : "always on its own"}</span>}
          </div>
        </div>
      )}
      {p.recent.length > 0 && (
        <div className="rows">
          {p.recent.slice(0, 20).map((e, i) => (
            <div key={i} className="row wh-row" style={{ gridTemplateColumns: "120px 190px minmax(0, 1fr)", cursor: "default" }}>
              <span className="mono small dim">{shortDate(e.ts)}</span>
              <span className={`small ${e.level === "warn" ? "warn" : ""}`}>{e.what}</span>
              <span className="small dim ellipsis">{e.detail}</span>
            </div>
          ))}
        </div>
      )}
      {p.recent.length > 20 && <span className="dim small">and {p.recent.length - 20 + (p.more || 0)} older</span>}
    </div>
  );
}

// The header's ⋯ menu: the actions used less often than Pin (UU-C-293).
function HeadMenu({ items }) {
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
  return (
    <span className="dv-menu" ref={box}>
      <button className="btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>More <Icon name="dots" size={16} /></button>
      {open && (
        <span className="dv-pop" role="menu">
          {items.map((i) =>
            i.href ? (
              <a key={i.label} role="menuitem" href={i.href}>{i.label}</a>
            ) : (
              <button key={i.label} role="menuitem" className={i.bad ? "bad" : ""} disabled={i.disabled} onClick={() => { setOpen(false); i.run(); }}>{i.label}</button>
            )
          )}
        </span>
      )}
    </span>
  );
}

export default function Device({ route }) {
  const mac = String(route.arg || "").toLowerCase();
  const date = route.query.d || todayKey();
  const isToday = date === todayKey();
  const period = isToday ? "period=today" : `period=custom&date=${date}`;
  const report = useApi(`/api/report?${period}&mac=${encodeURIComponent(mac)}`);
  const wifi = useApi(`/api/wifi?${period}&mac=${encodeURIComponent(mac)}`);
  const day = useApi(`/api/day?date=${date}`);
  const seen = useApi(`/api/devices/${encodeURIComponent(mac)}/presence?days=7`); // UU-C-124
  const places = useApi(`/api/devices/${encodeURIComponent(mac)}/places?days=30`); // UU-C-248
  const joins = useApi(`/api/wifi-joins?days=7&mac=${encodeURIComponent(mac)}`); // UU-C-146
  const jd = joins.data?.devices?.[0] || null;
  const probs = useApi(`/api/devices/${encodeURIComponent(mac)}/wifi-problems?date=${date}`).data; // UU-C-299
  // Blocked state lives in UniFi's full client list (a blocked device is usually offline).
  const clients = useApi("/api/clients?scope=all");
  const [blockedNow, setBlocked] = useState(null);
  const blocked = blockedNow ?? Boolean(clients.data?.clients?.find((c) => String(c.mac).toLowerCase() === mac)?.blocked);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const pins = usePins();
  const pinned = Boolean(pins?.some((p) => p.mac === mac));
  const devices = useApi("/api/devices");
  const dev = devices.data?.devices?.find((x) => x.mac === mac) || null;
  const [kindNow, setKindNow] = useState(undefined);
  const [picking, setPicking] = useState(false);
  const TABS = ["summary", "apps", "connection", "online"];
  const tab = TABS.includes(route.query.tab) ? route.query.tab : "summary";
  const tabHref = (t) => href("device", mac, { ...route.query, tab: t === "summary" ? null : t });

  const row = day.data?.rows?.find((r) => r.mac === mac) || null;
  const r = report.data;
  const w = wifi.data;
  const name = row?.name || r?.clients?.[0]?.name || w?.name || mac;
  const link = row?.link || null;

  // Signal per hour from the 5-minute samples.
  const sigHours = useMemo(() => {
    const out = Array.from({ length: 24 }, () => []);
    if (!w?.series || !day.data) return out.map(() => null);
    for (const s of w.series) {
      const h = Math.floor((s.t - day.data.start) / HOUR);
      if (h >= 0 && h < 24 && s.signal != null) out[h].push(s.signal);
    }
    return out.map((l) => (l.length ? Math.round(l.reduce((a, b) => a + b, 0) / l.length) : null));
  }, [w, day.data]);

  const timeline = (r?.timeline || []).slice(0, 24);
  const tmax = Math.max(1, ...timeline.map((b) => b.totalBytes || 0));
  const appsMax = Math.max(1, ...(r?.apps || []).map((a) => a.totalBytes));
  const items = useMemo(() => {
    const list = [];
    const likely = topOwner(r?.unnamedTo);
    for (const s of r?.sessions || []) list.push({ ts: s.start, at: `${clock(s.start)} – ${clock(s.end)}`, what: s.site ? `${s.site} (${s.app})` : s.app === "Unidentified" && likely ? `Unidentified · likely ${likely}` : s.app, detail: sessionDetail(s), v: bytes(s.bytes), n: s.bytes, down: s.down, up: s.up, kind: "session" });
    for (const e of r?.siem?.events || []) list.push({ ts: e.ts, at: clock(e.ts), what: e.name, detail: [e.via, e.duration, e.usageDown && `↓ ${e.usageDown}`].filter(Boolean).join(" · "), v: "", kind: "event" });
    for (const x of w?.roams || []) if (!list.some((i) => i.kind === "event" && Math.abs(i.ts - x.ts) < 2000)) list.push({ ts: x.ts, at: clock(x.ts), what: "Roamed", detail: x.msg || x.via || "", v: "", kind: "event" });
    // Failed Wi-Fi joins of this day, one line per hour and problem (UU-C-146).
    if (day.data) {
      const hours = new Map();
      for (const f of joins.data?.failures || []) {
        if (f.ts < day.data.start || f.ts >= day.data.start + 24 * HOUR) continue;
        const k = `${Math.floor((f.ts - day.data.start) / HOUR)}|${f.problem}`;
        const g = hours.get(k) || { first: f.ts, last: f.ts, n: 0, label: f.label, aps: new Set() };
        g.n += f.n;
        g.first = Math.min(g.first, f.ts);
        g.last = Math.max(g.last, f.ts);
        if (f.ap) g.aps.add(f.ap);
        hours.set(k, g);
      }
      for (const g of hours.values()) list.push({ ts: g.last, at: g.first === g.last ? clock(g.last) : `${clock(g.first)} – ${clock(g.last)}`, what: `${g.label}${g.n > 1 ? ` ×${g.n}` : ""}`, detail: [...g.aps].join(", "), v: "", kind: "joinfail" });
    }
    // The access points' own log (UU-C-299): DNS timeouts, anomalies, and leaves it removed.
    for (const e of probs?.recent || []) if (e.kind !== "leave" || e.level === "warn") list.push({ ts: e.ts, at: clock(e.ts), what: e.what, detail: e.detail, v: "", kind: e.level === "warn" ? "joinfail" : "event" });
    return list.sort((a, b) => b.ts - a.ts);
  }, [r, w, joins.data, day.data, probs]);

  async function toggleBlock() {
    const next = !blocked;
    if (!window.confirm(next ? `Block ${name}? It loses network access until you unblock it.` : `Unblock ${name}?`)) return;
    setBusy(true);
    setMsg("");
    try {
      const res = await api(`/api/clients/${encodeURIComponent(mac)}/block`, { method: "POST", body: JSON.stringify({ blocked: next }) });
      setBlocked(Boolean(res.blocked));
      setMsg(res.blocked ? "Blocked in UniFi." : "Unblocked in UniFi.");
    } catch (err) {
      setMsg(err.message);
    } finally {
      setBusy(false);
    }
  }

  function exportCsv() {
    const body = csv([["time", "type", "what", "detail", "data", "down", "up"], ...items.map((i) => [new Date(i.ts).toISOString(), i.kind, i.what, i.detail, i.v, i.down != null ? bytes(i.down) : "", i.up != null ? bytes(i.up) : ""])]);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([body], { type: "text/csv" }));
    a.download = `netlens-${name.replace(/[^\w.-]+/g, "_")}-${date}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const loading = report.loading && !r;
  const err = report.error || wifi.error || day.error;
  const current = w?.current;
  const wired = link ? link.wired : w?.wired;
  const poorHours = sigHours.filter((s) => s != null && s < -80).length;
  // What stands out on this day, in one place (UU-C-293); each line opens the tab with the detail.
  const kind = kindNow !== undefined ? (kindNow ? { ...dev?.type, kind: kindNow, source: "you" } : { ...dev?.type, source: "unifi" }) : dev?.type;
  const notes = [];
  if (!wired && poorHours > 0) notes.push({ level: "warn", text: `Weak signal for ${poorHours} hour${poorHours === 1 ? "" : "s"} ${isToday ? "today" : "that day"} (below −80 dBm)`, tab: "connection" });
  if (wired && link?.speed != null && link.speed <= 100 && !row?.usualSpeed) notes.push({ level: "warn", text: `Linked at only ${speed(link.speed)} on ${link.via || "its switch"}${link.port != null ? ` port ${link.port}` : ""}`, tab: "connection" });
  if (jd?.fails) notes.push({ level: "warn", text: `${jd.fails} failed Wi-Fi join${jd.fails === 1 ? "" : "s"} in 7 days: ${jd.problems.map((p) => p.label.toLowerCase()).join(", ")}`, tab: "connection" });
  if (blocked) notes.push({ level: "bad", text: "Blocked in UniFi: no network access until you unblock it" });
  const blockHours = (row?.marks || []).filter((m) => m?.block).length;
  if (blockHours) notes.push({ level: "info", text: `UniFi blocked its connections in ${blockHours} hour${blockHours === 1 ? "" : "s"}`, href: href("security") });
  if (!wired && (w?.roams?.length || 0) >= 20) notes.push({ level: "info", text: `Roamed ${w.roams.length} times between access points`, tab: "connection" });
  if (dev?.host) notes.push({ level: "info", text: `Runs on ${dev.host.name}`, tab: "connection" });
  if (probs?.dns?.timeouts) notes.push({ level: "warn", text: `DNS lookups timed out ${probs.dns.timeouts} time${probs.dns.timeouts === 1 ? "" : "s"} ${isToday ? "today" : "that day"}`, tab: "connection" });
  if (probs?.anomalies?.length) notes.push({ level: "warn", text: `Its access point flagged ${probs.anomalies.map((a) => `${a.label} ×${a.n}`).join(", ")}${probs.anomalies[0].signal != null ? ` (signal around ${probs.anomalies[0].signal} dBm)` : ""}`, tab: "connection" });
  const kicked = (probs?.leaves || []).filter((l) => !l.own);
  if (kicked.length) notes.push({ level: "warn", text: `Removed from Wi-Fi by the access point ${kicked.length} time${kicked.length === 1 ? "" : "s"}: ${[...new Set(kicked.map((l) => l.why))].join(", ")}`, tab: "connection" });
  if (r?.uncounted) notes.push({ level: "info", text: "UniFi counted no internet traffic for it; the connection records did", tab: "apps" });
  const appsTop = r ? r.apps.slice(0, tab === "apps" ? 40 : 5) : [];

  const appsCard = r && (
    <div className="card">
      <div className="card-head">
        <h2>Apps</h2>
        {tab === "summary" && r.apps.length > 5 ? <a className="end small" href={tabHref("apps")}>All {r.apps.length}</a> : <a className="end small" href={href("usage", null, { d: date, mac })}>On the Apps page</a>}
      </div>
      {!r.apps.length && !r.uncounted && <span className="dim">No traffic counted.</span>}
      {r.uncounted && tab === "apps" && (
        <p className="dim small" style={{ margin: 0 }}>
          UniFi counted no internet traffic for this device, but its connection records show <Bytes n={r.uncounted.bytes} /> (↓ <Bytes n={r.uncounted.down} /> ↑ <Bytes n={r.uncounted.up} />) with {r.uncounted.apps.join(", ")}
          {r.uncounted.more ? ` and ${r.uncounted.more} more` : ""}. Connection records miss most of a long connection such as a VPN tunnel, so the real amount can be higher.
        </p>
      )}
      {appsTop.map((a) => (
        <a key={a.appId} href={href("usage", null, { d: date, mac, app: a.appId })} style={{ color: "var(--text)", display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 4 }}>
          <span style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
            <span className="ellipsis" style={{ minWidth: 0 }}>{a.app} <span className="dim small">· {a.category}</span></span>
            <span className="mono" style={{ textAlign: "right", flexShrink: 0 }}><Bytes n={a.totalBytes} /><Split down={a.bytesRx} up={a.bytesTx} /></span>
          </span>
          <Meter share={a.totalBytes / appsMax} />
          {a.app === "Unidentified" && r.unnamedTo ? <UnnamedTo u={r.unnamedTo} /> : null}
        </a>
      ))}
      {r.localBytes > 0 && tab === "apps" && (
        <p className="dim small" style={{ margin: 0 }}>
          Plus <Bytes n={r.localBytes} />{Number(r.localDown) || Number(r.localUp) ? <> (↓ <Bytes n={r.localDown} /> ↑ <Bytes n={r.localUp} />)</> : null} inside your own network ({r.localServices.slice(0, 3).map((s) => s.app).join(", ")}), which UniFi does not count.
        </p>
      )}
    </div>
  );
  const eventsShown = tab === "summary" ? items.slice(0, 6) : items.slice(0, 60);
  const eventsCard = r && (
    <div className="card">
      <div className="card-head">
        <h2>{tab === "summary" ? "Latest sessions and events" : "Sessions and events"}</h2>
        {tab === "summary" ? (items.length > 6 ? <a className="end small" href={tabHref("apps")}>All {items.length}</a> : null) : <button className="btn small end" onClick={exportCsv} disabled={!items.length}>Export CSV</button>}
      </div>
      {!items.length && <span className="dim">Nothing recorded.</span>}
      <div className="rows">
        {eventsShown.map((i, n) => (
          <div key={n} className="row" style={{ gridTemplateColumns: "104px minmax(0, 1fr) auto" }}>
            <span className="mono small dim">{i.at}</span>
            <span className="stack">
              <span style={{ color: i.kind === "session" ? "var(--accent)" : i.kind === "joinfail" ? "var(--bad)" : "var(--text-soft)" }}>{i.what}</span>
              <span className="dim small ellipsis">{i.detail}</span>
            </span>
            <span className="mono small" style={{ textAlign: "right" }}>{i.n != null ? <><Bytes n={i.n} /><Split down={i.down} up={i.up} /></> : i.v}</span>
          </div>
        ))}
      </div>
    </div>
  );
  const tabs = [
    ["summary", "Summary"],
    ["apps", "Apps and events", r ? `${r.apps.length} · ${items.length}` : null],
    ["connection", "Connection", null, notes.some((x) => x.tab === "connection" && x.level === "warn")],
    ["online", "Online history", seen.data?.log?.length || null],
  ];
  return (
    <div className="page narrow">
      <div className="crumbs">
        <a href={href("devices")}>Devices</a>
        <span>/</span>
        <a href={href("day", null, { d: date })}>Day</a>
        <span>/</span>
        <span>{name}</span>
      </div>
      <div className="page-head">
        <div className="titles">
          <h1 className="dvp-title">
            <span className="dv-icon big" title={kind ? `${kindLabel(kind.kind)} · ${kindSource(kind)}` : undefined}><Icon name={kind?.kind || "other"} size={24} /></span>
            <span className="ellipsis">{name}</span>
          </h1>
          <span className="muted">
            {link?.unsampled && !current && !link.via
              ? `${wired ? "Wired" : "Wi-Fi"} · no connection details that day`
              : link?.unsampled && !current && !wired
              ? `Wi-Fi · ${link.via}${link.band ? ` · ${link.band}` : ""}${link.signal != null ? ` · ${link.signal} dBm` : ""} · from UniFi's System Log`
              : wired
              ? `Wired · ${link?.via || "switch"}${link?.port != null ? ` port ${link.port}` : ""}${link?.speed ? ` · ${speed(link.speed)}` : ""}`
              : current
                ? `Wi-Fi ${BAND[current.band] || current.band || ""} on ${current.ap}${current.essid ? ` · ${current.essid}` : ""}`
                : "Not seen on this day"}
            {link?.uptime != null ? ` · connected ${duration(link.uptime)}` : ""}
          </span>
          <span className="dim small">
            {[kind?.model && kind.source !== "none" ? kind.model : null, dev?.vendor || (dev?.privateMac ? "private address" : null)].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).map((v) => `${v} · `).join("")}
            {row?.ip && (
              <>
                <span className="mono" title={row.ipLastKnown ? "No address recorded that day; this is the last one known" : "Its address that day"}>{row.ip}</span>
                {row.ipLastKnown && <span> (last known)</span>}
                {" · "}
              </>
            )}
            <span className="mono">{mac}</span>
          </span>
        </div>
        <DayStep date={date} onDate={(d) => go("device", mac, { ...route.query, d: d === todayKey() ? null : d })} />
        {/* Pinned devices sit in the sidebar on every screen (UU-C-289). */}
        <button className={`btn pin ${pinned ? "on" : ""}`} aria-pressed={pinned} title={pinned ? "Remove from the sidebar" : "Keep this device in the sidebar"} onClick={() => setPinned(mac, !pinned, name).catch((e) => setMsg(e.message))}>
          {pinned ? "★ Pinned" : "☆ Pin"}
        </button>
        <HeadMenu
          items={[
            { label: "Rename", href: href("devices", null, { mac }) },
            { label: "Set type", run: () => setPicking(true), disabled: !dev },
            { label: "Sites it visited", href: href("sites", null, { mac, d: date === todayKey() ? null : date }) },
            { label: "Its apps on the Apps page", href: href("usage", null, { d: date, mac }) },
            { label: blocked ? "Unblock" : "Block device", run: toggleBlock, bad: !blocked, disabled: busy },
          ]}
        />
      </div>
      {picking && dev && (
        <div className="card tight">
          <KindPicker d={{ ...dev, label: name, type: kind }} onSaved={(k) => setKindNow(k)} onCancel={() => setPicking(false)} />
        </div>
      )}
      {msg && <p className="note">{msg}</p>}
      {err && <Failed error={err} />}
      {loading && <Loading />}
      {r && (
        <>
          <nav className="dtabs" role="tablist" aria-label="Device sections">
            {tabs.map(([id, label, count, alert]) => (
              <a key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} href={tabHref(id)}>
                {label}
                {count ? <span className="dim small"> {count}</span> : null}
                {alert ? <span className="dtab-alert" title="Something here needs a look" /> : null}
              </a>
            ))}
          </nav>

          {tab === "summary" && (
            <>
              <div className="grid g4 dvp-stats">
            <div className="card tight stat">
              <span className="label">{isToday ? "Today" : "That day"}</span>
              <span className="value"><Bytes n={r.totals.bytes} /></span>
              <span className="sub">
                {r.uncounted ? (
                  <>UniFi counted nothing · connection records: <Bytes n={r.uncounted.bytes} /></>
                ) : (
                  <>↓ <Bytes n={r.totals.rx} /> · ↑ <Bytes n={r.totals.tx} /></>
                )}
              </span>
            </div>
            {wired ? (
              <>
                <div className="card tight stat">
                  <span className="label">Link speed</span>
                  <span className={`value ${link?.speed <= 100 && !row?.usualSpeed ? "warn" : ""}`} title={row?.usualSpeed ? "Its usual speed: it never linked faster in 30 days" : undefined}>{speed(link?.speed)}</span>
                  <span className="sub">{link?.via || "—"}{link?.port != null ? ` · port ${link.port}` : ""}</span>
                  {/* The busiest 5 minutes that day on its port (UU-C-239). */}
                  {row?.busiest && (
                    <span className={`sub ${row.busiest.share >= 0.8 ? "warn" : ""}`} title={`${row.busiest.dir === "toDevice" ? "To the device" : "From the device"}, ${clock(row.busiest.from)}–${clock(row.busiest.at)}`}>
                      busiest {Math.round((row.busiest.at - row.busiest.from) / 60e3)} min: {row.busiest.bps >= 1e6 ? `${Math.round(row.busiest.bps / 1e6)} Mbps` : `${Math.round(row.busiest.bps / 1e3)} kbps`}
                      {row.busiest.share != null ? ` · ${Math.max(1, Math.round(row.busiest.share * 100))}% of the link` : ""}
                    </span>
                  )}
                </div>
                <div className="card tight stat">
                  <span className="label">Connected</span>
                  <span className="value">{duration(link?.uptime)}</span>
                  <span className="sub">as UniFi counts it</span>
                </div>
              </>
            ) : (
              <>
                <div className="card tight stat">
                  {/* Without samples: the last signal UniFi's System Log recorded (UU-C-102). */}
                  {(() => {
                    const sig = current ? current.signal : link?.unsampled ? link.signal : null;
                    return (
                      <>
                        <span className="label">{current ? "Signal now" : "Last logged signal"}</span>
                        <span className={`value ${sig < -80 ? "bad" : sig < -75 ? "warn" : ""}`}>{sig ?? "—"} dBm</span>
                        <span className="sub">
                          {current
                            ? `at ${clock(current.ts)} · average ${w.summary.avgSignal ?? "—"}`
                            : link?.logged
                              ? `System Log, ${shortDate(link.logged)}${w?.source === "log" && w.summary.avgSignal != null ? ` · average ${w.summary.avgSignal}` : ""}`
                              : "no sample"}
                        </span>
                      </>
                    );
                  })()}
                </div>
                <div className="card tight stat">
                  <span className="label">Link</span>
                  <span className="value small">{current ? `Tx ${rate(current.txRate)} · Rx ${rate(current.rxRate)}` : link?.via ? `${link.via}${link.band ? ` · ${link.band}` : ""}` : "—"}</span>
                  <span className="sub">{current ? `ch ${current.channel}${current.width ? ` · ${current.width} MHz` : ""}` : link?.channel ? `ch ${link.channel}${link.aps?.length > 1 ? ` · used ${link.aps.join(", ")}` : ""}` : ""}</span>
                </div>
              </>
            )}
            <div className="card tight stat">
              <span className="label">{wired ? "Apps" : "Roams"}</span>
              <span className="value">{wired ? r.apps.length : w?.roams?.length ?? 0}</span>
              <span className="sub">{wired ? "seen that day" : w?.favoriteAp ? `mostly on ${w.favoriteAp.ap}` : "from UniFi's log"}</span>
            </div>
          </div>
              {notes.length > 0 && (
                <div className="card tight">
                  <div className="dvp-notes">
                    {notes.map((n, i) => {
                      const body = <><span className={`status-dot ${n.level === "warn" ? "warn" : n.level === "bad" ? "bad" : "off"}`} /> {n.text}</>;
                      return n.tab ? <a key={i} href={tabHref(n.tab)} className="dvp-note">{body}<span className="dim small"> · details</span></a> : n.href ? <a key={i} href={n.href} className="dvp-note">{body}</a> : <span key={i} className="dvp-note">{body}</span>;
                    })}
                  </div>
                </div>
              )}
              <div className="card">
            <div className="card-head">
              <h2>Its day</h2>
              <span className="hint">by hour · click an hour to see it in 5-minute steps</span>
            </div>
            <div className="heat" style={{ gridTemplateColumns: "70px repeat(24, minmax(0, 1fr))" }}>
              <span className="dim small">Traffic</span>
              {Array.from({ length: 24 }, (_, h) => {
                const b = timeline[h];
                const later = !b || (isToday && b.t > Date.now());
                const nodata = b && !later && b.lost >= 0.99;
                return (
                  <button
                    key={h}
                    className={`cell ${later ? "later" : nodata ? "nodata" : ""}`}
                    style={later || nodata ? undefined : { background: b.totalBytes > 0 ? `color-mix(in srgb, var(--cell-4) ${Math.round(25 + 75 * Math.sqrt(b.totalBytes / tmax))}%, var(--cell-0))` : "var(--cell-0)" }}
                    title={b ? `${b.label} · ${bytes(b.totalBytes)}${splitTip(b.down, b.up)}` : ""}
                    onClick={() => !later && !nodata && b && go("usage", null, { d: date, from: b.t, to: b.t + HOUR, mac })}
                  />
                );
              })}
              {!wired && <span className="dim small">Signal</span>}
              {!wired &&
                sigHours.map((s, h) => (
                  <span key={h} className="cell" style={{ background: s == null ? "var(--cell-0)" : sigColor(s), cursor: "default" }} title={s == null ? (w?.source === "log" ? "nothing logged" : "no sample") : `${s} dBm${w?.source === "log" ? " (System Log)" : ""}`} />
                ))}
              <span className="dim small">Events</span>
              {Array.from({ length: 24 }, (_, h) => {
                const m = row?.marks?.[h];
                return (
                  <span key={h} className="small" style={{ textAlign: "center", color: m?.block ? "var(--bad)" : "var(--text-soft)" }}>
                    {m?.block ? "▲" : m?.roam || m?.conn ? "○".repeat(Math.min(2, (m.roam || 0) + (m.conn || 0))) : ""}
                  </span>
                );
              })}
              <span />
              {Array.from({ length: 24 }, (_, h) => (
                <span key={h} className="mono" style={{ textAlign: "center", fontSize: 10.5, color: "var(--faint)" }}>
                  {h % 3 === 0 ? String(h).padStart(2, "0") : ""}
                </span>
              ))}
            </div>
            <div className="legend">
              <span><i style={{ background: "var(--cell-4)" }} />traffic</span>
              {!wired && (
                <>
                  <span><i style={{ background: "var(--sig-good)" }} />good signal</span>
                  <span><i style={{ background: "var(--sig-weak)" }} />weak (below −75)</span>
                  <span><i style={{ background: "var(--sig-bad)" }} />poor (below −80)</span>
                </>
              )}
              <span>○ roam / connect</span>
              <span><span className="bad">▲</span> blocked</span>
            </div>
            {w?.source === "log" && !wired ? (
              <p className="dim small" style={{ margin: 0 }}>
                NetLens took no samples this day: signal is what UniFi's System Log recorded at each connect, roam and disconnect, and time per access point runs between them.
              </p>
            ) : w?.sampledSince > (day.data?.start || 0) && !wired && (
              <p className="dim small" style={{ margin: 0 }}>
                NetLens started sampling Wi-Fi {new Date(w.sampledSince).toLocaleString()}; signal before that is unknown. Roams come from UniFi's own log.
              </p>
            )}
          </div>
              <div className="grid g2">
                {appsCard}
                {eventsCard}
              </div>
            </>
          )}

          {tab === "apps" && (
            <div className="grid g2">
              {appsCard}
              {eventsCard}
            </div>
          )}

          {tab === "connection" && (
            <>
              <RunsOn mac={mac} list={devices} />
              {jd && (
            <div className="card">
              <div className="card-head">
                <h2>Wi-Fi joins</h2>
                <span className="dim small">
                  last 7 days · {jd.joins} joined{jd.fails ? <> · <span className="warn">{jd.fails} failed</span></> : ""}
                  {jd.joinMs != null ? ` · typical join ${jd.joinMs < 1000 ? `${jd.joinMs} ms` : `${(jd.joinMs / 1000).toFixed(1)} s`}` : ""}
                </span>
              </div>
              {!jd.problems.length && <span className="dim small">Every attempt got in.</span>}
              <div className="rows">
                {jd.problems.map((p) => (
                  <div key={p.key} className="row" style={{ gridTemplateColumns: "minmax(0, 1fr) auto", cursor: "default" }}>
                    <span className="stack">
                      <span><span className="warn">{p.label}</span> <span className="dim">×{p.n} · last {shortDate(p.last)} · {p.aps.map((a) => `${a.name} (${a.n})`).join(", ")}</span></span>
                      {p.hint && <span className="dim small">{p.hint}</span>}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
              {w && !wired && <WifiProblems mac={mac} />}
              {w && !wired && <WifiHistory mac={mac} />}
              {places.data?.places?.length > 0 && (
            <div className="card">
              <div className="card-head">
                <h2>Where it connected</h2>
                <span className="dim small">last 30 days · port and network · a change counts once it stayed 15 minutes</span>
              </div>
              <div className="rows">
                {places.data.places.map((p) => (
                  <div key={`${p.apMac}|${p.port}|${p.from}`} className="row" style={{ gridTemplateColumns: "minmax(0, 1fr) auto", cursor: "default" }}>
                    <span className="small">
                      <a href={href("network", null, { n: p.apMac })}>{p.via}</a> · port {p.port}
                      {p.network ? <span> · {p.network}{p.vlan > 1 && !/vlan/i.test(p.network) ? <span className="dim"> (VLAN {p.vlan})</span> : null}</span> : null}
                      {p.ip ? <span className="dim mono"> · {p.ip}</span> : null}
                      {p.current ? <span className="ok"> · now</span> : null}
                    </span>
                    <span className="mono small dim">{shortDate(p.from)} – {p.current ? "now" : shortDate(p.to)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
              {!jd && !(w && !wired) && !places.data?.places?.length && <div className="card"><span className="dim">No connection history recorded for this device.</span></div>}
            </>
          )}

          {tab === "online" && (
            <>
              {seen.data?.log?.length > 0 && (
            <div className="card">
              <div className="card-head">
                <h2>Online history</h2>
                <span className="dim small">last 7 days · checked with every update</span>
              </div>
              <div className="rows">
                {[...seen.data.log].reverse().slice(0, 100).map((e) => (
                  <div key={e.ts} className="row" style={{ gridTemplateColumns: "150px 14px minmax(0, 1fr)", cursor: "default" }}>
                    <span className="mono small dim">{shortDate(e.ts)}</span>
                    <span className={`status-dot ${e.state === "online" ? "" : e.state === "lan" ? "warn" : "off"}`} />
                    <span className="small">
                      {e.state === "online" ? "Online in UniFi" : e.state === "lan" ? "On the network, not in UniFi" : "Offline — no answer"}
                      {e.method && e.state !== "online" ? <span className="dim"> · {e.method}</span> : null}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
              {!seen.data?.log?.length && <div className="card"><span className="dim">No online or offline changes in the last 7 days.</span></div>}
            </>
          )}
        </>
      )}
    </div>
  );
}
