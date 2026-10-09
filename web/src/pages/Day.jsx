import { useState } from "react";
import { bytes, go, href, speed, todayKey, useApi } from "../lib.js";
import { DayStep, Failed, Loading, healthClass } from "../ui.jsx";

// Day — every device as a row, the day's hours as columns (UU-C-087). Colour is traffic in
// that hour; ○ roams/connects, ▲ blocked traffic; hatched = no data.

const HOUR = 3600000;

function linkText(link) {
  if (!link) return "not seen";
  if (link.unsampled) return `${link.wired ? "Wired" : "Wi-Fi"} · no connection details that day`;
  if (link.wired) return `Wired · ${link.via || "switch"}${link.port != null ? ` port ${link.port}` : ""}${link.speed ? ` · ${speed(link.speed)}` : ""}`;
  return `Wi-Fi · ${link.via || "AP"}${link.signal != null ? ` · ${link.signal} dBm` : ""}`;
}

function shade(v, max) {
  if (!(v > 0)) return "var(--cell-0)";
  const s = Math.sqrt(v / max); // square root, so one huge device does not wash out the rest
  return s < 0.12 ? "var(--cell-1)" : s < 0.3 ? "var(--cell-2)" : s < 0.5 ? "var(--cell-3)" : s < 0.8 ? "var(--cell-4)" : "var(--cell-5)";
}

function mark(m) {
  if (!m) return "";
  if (m.block) return "▲";
  if (m.roam || m.conn) return "○";
  return "";
}

export default function Day({ route }) {
  const date = route.query.d || todayKey();
  const [show, setShow] = useState("all");
  const { data, error, loading, reload } = useApi(`/api/day?date=${date}`, date === todayKey() ? 5 * 60 * 1000 : 0);
  const rows = (data?.rows || []).filter((r) => (show === "all" ? true : show === "wired" ? r.link?.wired : r.link && !r.link.wired));
  const max = Math.max(1, ...(data?.rows || []).flatMap((r) => r.hourly));
  const netMax = Math.max(1, ...(data?.network.hourly || [0]));
  const cols = "minmax(180px, 250px) repeat(24, minmax(0, 1fr)) 84px";
  const top = data?.rows?.[0];
  const cellState = (h) => (data.detail[h] == null ? "later" : data.detail[h] ? "" : "nodata");
  return (
    <div className="page">
      <div className="page-head">
        <div className="titles">
          <span className="dim small">Day</span>
          {data && (
            <p className="lede">
              {bytes(data.network.total)}
              <span className="soft">{data.today ? " so far" : ""}</span>
              {top && top.total > 0 && (
                <>
                  <span className="soft"> — busiest </span>
                  <a href={href("device", top.mac, { d: date })}>{top.name}</a>
                  <span className="soft"> with {bytes(top.total)}.</span>
                </>
              )}
            </p>
          )}
        </div>
        <DayStep date={date} onDate={(d) => go("day", null, { d: d === todayKey() ? null : d })} />
      </div>
      {error && <Failed error={error} reload={reload} />}
      {!data && loading && <Loading />}
      {data && (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "center" }}>
            <div className="seg" role="group" aria-label="Show">
              {[
                ["all", `All · ${data.rows.length}`],
                ["wifi", "Wi-Fi"],
                ["wired", "Wired"],
              ].map(([id, label]) => (
                <button key={id} className={show === id ? "on" : ""} onClick={() => setShow(id)}>
                  {label}
                </button>
              ))}
            </div>
            <div className="legend" style={{ marginLeft: "auto" }}>
              <span><i style={{ background: "var(--cell-4)" }} />traffic</span>
              <span>○ roam / connect</span>
              <span><span className="bad">▲</span> blocked</span>
              <span><i style={{ background: "repeating-linear-gradient(45deg, #2a3140 0 3px, #161b24 3px 6px)" }} />no data</span>
            </div>
          </div>
          {data.lostSpans?.length > 0 && (
            <p className="note warn">
              Part of this day was never saved: UniFi had already deleted the detail before NetLens could read it. Those hours
              are hatched, not empty.
            </p>
          )}
          <div className="card scroll-x" style={{ padding: "14px 16px" }}>
            <div className="heat" style={{ gridTemplateColumns: cols, minWidth: 980 }}>
              <span />
              {data.hours.map((t, h) => (
                <button
                  key={t}
                  className="hdr"
                  title={`Open ${String(h).padStart(2, "0")}:00 for the whole network`}
                  onClick={() => go("usage", null, { d: date, from: t, to: t + HOUR })}
                >
                  {h % 3 === 0 ? String(h).padStart(2, "0") : "·"}
                </button>
              ))}
              <span className="tot dim small">total</span>

              <a className="who" href={href("usage", null, { d: date })}>
                <span className="status-dot" />
                <span className="stack">
                  <strong className="nm">Whole network</strong>
                  <span className="dim small">{data.rows.length} devices</span>
                </span>
              </a>
              {data.network.hourly.map((v, h) => (
                <button
                  key={h}
                  className={`cell ${cellState(h)}`}
                  style={cellState(h) ? undefined : { background: shade(v, netMax) }}
                  title={`${String(h).padStart(2, "0")}:00 · ${bytes(v)}`}
                  onClick={() => !cellState(h) && go("usage", null, { d: date, from: data.hours[h], to: data.hours[h] + HOUR })}
                />
              ))}
              <span className="tot">{bytes(data.network.total)}</span>

              {rows.map((r) => [
                <a key={`${r.mac}-n`} className="who" href={href("device", r.mac, { d: date })} style={{ borderTop: "1px solid #171d28", paddingTop: 6 }}>
                  <span className={`status-dot ${healthClass(r.health)}`} />
                  <span className="stack">
                    <span className="nm ellipsis">{r.name}</span>
                    <span className="dim small ellipsis">{linkText(r.link)}</span>
                  </span>
                </a>,
                ...r.hourly.map((v, h) => {
                  const st = cellState(h);
                  const m = r.marks?.[h];
                  return (
                    <button
                      key={`${r.mac}-${h}`}
                      className={`cell ${st}`}
                      style={st ? undefined : { background: shade(v, max), color: m?.block ? "var(--bad)" : undefined }}
                      title={`${r.name} · ${String(h).padStart(2, "0")}:00 · ${bytes(v)}${m?.roam ? ` · ${m.roam} roam(s)` : ""}${m?.conn ? ` · ${m.conn} connect(s)` : ""}${m?.block ? ` · ${m.block} blocked` : ""}`}
                      onClick={() => !st && go("usage", null, { d: date, from: data.hours[h], to: data.hours[h] + HOUR, mac: r.mac })}
                    >
                      {st ? "" : mark(m)}
                    </button>
                  );
                }),
                <span key={`${r.mac}-t`} className="tot">{bytes(r.total)}</span>,
              ])}
            </div>
            {!rows.length && <div className="empty">No devices for this filter on this day.</div>}
          </div>
        </>
      )}
    </div>
  );
}
