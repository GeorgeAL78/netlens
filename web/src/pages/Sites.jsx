import { useEffect, useState } from "react";
import { api, bytes, clock, dayLabel, go, href, todayKey, useApi } from "../lib.js";
import { DayStep, Failed, Finder, Loading } from "../ui.jsx";

// Sites (UU-C-135): every site each device connected to, from the connection records NetLens
// keeps (30 days), with a chip per category. Not a DNS log — UniFi has none — and a browser
// using secure DNS leaves only an address, which the watch list names where it can.

const RANGES = [
  ["day", "Day"],
  ["7d", "7 days"],
  ["30d", "30 days"],
];
const SORTS = [
  ["n", "Connections"],
  ["bytes", "Data"],
  ["last", "Last seen"],
];

const when = (ms) => (ms ? `${new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" })} ${clock(ms)}` : "—");

// "Oct 10 08:00 – 22:55" on one day, both dates across days.
const span = (a, b) => {
  if (!a || a === b) return when(b);
  return new Date(a).toDateString() === new Date(b).toDateString() ? `${when(a)} – ${clock(b)}` : `${when(a)} – ${when(b)}`;
};

function params(q, extra = {}) {
  const p = new URLSearchParams();
  const range = q.r || "day";
  const date = q.d || todayKey();
  if (range === "day") {
    if (date === todayKey()) p.set("period", "today");
    else {
      p.set("period", "custom");
      p.set("date", date);
    }
  } else p.set("period", range);
  for (const k of ["mac", "cat", "q", "bg", "group", "sort"]) if (q[k]) p.set(k, q[k]);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p;
}

function MatchNote({ s }) {
  if (s.match === "address")
    return <span className={s.confidence === "possible" ? "dim small" : "warn small"} title={`UniFi kept only the address ${s.ip || ""}; NetLens's own lookup of this site returned it`}>matched by address{s.confidence === "possible" ? " (shared CDN, possible)" : ""}</span>;
  if (s.match === "network") return <span className="warn small" title="The address belongs to a network that only hosts sites of this kind">by network owner</span>;
  return null;
}

function Hits({ q, s }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    api(`/api/sites/hits?${params(q, { key: s.key })}`)
      .then((d) => setRows(d.hits || []))
      .catch((e) => setErr(e.message));
  }, [s.key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (err) return <div className="dim small">{err}</div>;
  if (!rows) return <div className="dim small">Loading connections…</div>;
  return (
    <div className="rows" style={{ gap: 2 }}>
      {rows.map((h, i) => (
        <div key={i} className="row small" style={{ gridTemplateColumns: "130px minmax(0, 1fr) minmax(0, 1fr) 80px", cursor: "default", padding: "4px 8px" }}>
          <span className="mono dim">{when(h.t)}</span>
          <a href={href("device", h.mac)} className="ellipsis">{h.device}</a>
          <span className="dim mono ellipsis">{h.domain}{h.ip && h.ip !== h.domain ? ` · ${h.ip}` : ""}</span>
          <span className="mono" style={{ textAlign: "right" }}>{bytes(h.bytes)}</span>
        </div>
      ))}
      {!rows.length && <div className="dim small">No timed connections.</div>}
      {rows.length === 50 && <div className="dim small">The newest 50.</div>}
    </div>
  );
}

export default function Sites({ route }) {
  const q = route.query;
  const range = q.r || "day";
  const date = q.d || todayKey();
  const { data: r, error, loading, reload } = useApi(`/api/sites?${params(q)}`);
  const set = (patch) => go("sites", null, { ...q, ...patch });
  const [text, setText] = useState(q.q || "");
  const [open, setOpen] = useState(null);
  useEffect(() => {
    const t = setTimeout(() => text !== (q.q || "") && set({ q: text || null }), 350);
    return () => clearTimeout(t);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setOpen(null), [r]);

  const cats = new Set(String(q.cat || "").split(",").filter(Boolean));
  const toggleCat = (c) => {
    const next = new Set(cats);
    next.has(c) ? next.delete(c) : next.add(c);
    set({ cat: [...next].join(",") || null });
  };
  const device = q.mac ? r?.devices?.find((d) => d.mac === q.mac)?.name || q.mac : null;
  const scope = range === "day" ? dayLabel(date) : `last ${range.replace("d", " days")}`;
  const allCount = (r?.categories || []).reduce((n, c) => n + c.sites, 0);
  const finderGroups = [
    { label: "", items: [{ key: "all", label: "All devices", sub: "", on: !q.mac, pick: () => set({ mac: null }) }] },
    { label: "Devices", items: (r?.devices || []).map((d) => ({ key: d.mac, label: d.name, sub: `${d.n.toLocaleString()} connections`, on: q.mac === d.mac, searchable: [d.mac], pick: () => set({ mac: d.mac }) })) },
  ];

  return (
    <div className="page">
      <div className="page-head">
        <div className="titles">
          <span className="dim small">Activity · Sites</span>
          <h1>{device || "All devices"}</h1>
          <span className="muted">
            {scope}
            {r ? ` · ${r.all.sites.toLocaleString()} sites, ${r.all.n.toLocaleString()} connections` : ""}
          </span>
        </div>
        <div className="seg" role="group" aria-label="Range">
          {RANGES.map(([id, label]) => (
            <button key={id} className={range === id ? "on" : ""} onClick={() => set({ r: id === "day" ? null : id })}>
              {label}
            </button>
          ))}
        </div>
        {r && <Finder className="finder" browse placeholder="Pick a device" groups={finderGroups} />}
        {range === "day" && <DayStep date={date} onDate={(d) => set({ d: d === todayKey() ? null : d })} />}
      </div>

      <div className="quick" role="group" aria-label="Categories">
        <button className={`btn small ${cats.size ? "" : "on"}`} onClick={() => set({ cat: null })}>
          All <span className="dim">{allCount}</span>
        </button>
        {(r?.categories || []).map((c) => (
          <button key={c.category} className={`btn small ${cats.has(c.category) ? "on" : ""}`} onClick={() => toggleCat(c.category)}>
            <span className={r.watch.categories.includes(c.category) ? "bad" : ""}>{c.category}</span> <span className="dim">{c.sites}</span>
          </button>
        ))}
      </div>

      <div className="card">
        <div className="card-head" style={{ gap: 10, flexWrap: "wrap" }}>
          <input className="field" style={{ minWidth: 220 }} placeholder="Search site, app or address" aria-label="Search sites" value={text} onChange={(e) => setText(e.target.value)} />
          <label className="small muted" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={q.group === "domain"} onChange={(e) => set({ group: e.target.checked ? "domain" : null })} />
            Group by domain
          </label>
          <label className="small muted" style={{ display: "inline-flex", gap: 6, alignItems: "center" }} title="Protocols, CDNs and connections nothing could name">
            <input type="checkbox" checked={q.bg !== "1"} onChange={(e) => set({ bg: e.target.checked ? null : "1" })} />
            Hide background{r?.hidden?.sites ? ` (${r.hidden.sites.toLocaleString()})` : ""}
          </label>
          <div className="seg" role="group" aria-label="Sort" style={{ marginLeft: "auto" }}>
            {SORTS.map(([id, label]) => (
              <button key={id} className={(q.sort || "n") === id ? "on" : ""} onClick={() => set({ sort: id === "n" ? null : id })}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {error && <Failed error={error} reload={reload} />}
        {!r && loading && <Loading />}
        {r && (
          <div className="scroll-x">
            <table className="t">
              <thead>
                <tr>
                  <th>Site</th>
                  <th>App · category</th>
                  {!q.mac && <th>Devices</th>}
                  <th className="num">Connections</th>
                  <th className="num">Data</th>
                  <th>First – last</th>
                </tr>
              </thead>
              <tbody>
                {r.sites.map((s) => [
                  <tr key={s.key} className="click" onClick={() => setOpen(open === s.key ? null : s.key)}>
                    <td style={{ maxWidth: 320 }}>
                      <div className="stack">
                        <span className="ellipsis" style={{ fontWeight: 500 }}>{s.site}</span>
                        {(s.match || (s.ip && s.ip !== s.site)) && (
                          <span className="dim small">
                            <MatchNote s={s} />
                            {s.ip && s.ip !== s.site ? ` ${s.ip}` : ""}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="muted small">
                      {s.app !== s.site ? `${s.app} · ` : ""}
                      <span className={r.watch.categories.includes(s.category) ? "bad" : ""}>{s.category}</span>
                    </td>
                    {!q.mac && (
                      <td className="muted small">
                        {s.top.map((d) => d.name).join(", ")}
                        {s.devices > s.top.length ? ` +${s.devices - s.top.length}` : ""}
                      </td>
                    )}
                    <td className="num">{s.n.toLocaleString()}</td>
                    <td className="num">{bytes(s.bytes)}</td>
                    <td className="dim small mono">{span(s.first, s.last)}</td>
                  </tr>,
                  open === s.key && (
                    <tr key={`${s.key}-hits`}>
                      <td colSpan={q.mac ? 5 : 6}>
                        <Hits q={q} s={s} />
                      </td>
                    </tr>
                  ),
                ])}
                {!r.sites.length && (
                  <tr>
                    <td colSpan={6} className="dim">
                      {r.days ? "No site matches." : "No connection records for this period — NetLens keeps them for 30 days."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        {r?.truncated && <p className="dim small" style={{ margin: 0 }}>Showing the first 2,000 of {r.total.sites.toLocaleString()} — search or pick a category to narrow it.</p>}
        <p className="note">
          Sites come from UniFi's connection records: the name it saw when the device looked the site up or opened the connection. A browser using
          secure DNS hides the name, and UniFi keeps only the address; NetLens then names it if the address belongs to a watched site
          ({r?.watch?.categories?.join(", ") || "Adult"}){r?.watch?.refreshedAt ? `, checked ${clock(r.watch.refreshedAt)}` : ""}. Lookups that never led to a connection, and traffic inside a VPN, are not visible.
        </p>
      </div>
    </div>
  );
}
