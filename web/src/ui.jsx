import { addDays, dayLabel, todayKey } from "./lib.js";

// Small building blocks shared by the pages (UU-C-087).

export function Loading({ what = "Loading…" }) {
  return <div className="loading">{what}</div>;
}

export function Failed({ error, reload }) {
  return (
    <div className="error" role="alert">
      {error}
      {reload && (
        <button className="btn small" style={{ marginLeft: 12 }} onClick={reload}>
          Try again
        </button>
      )}
    </div>
  );
}

// ‹ day › — step through days; today is the newest.
export function DayStep({ date, onDate }) {
  const today = todayKey();
  return (
    <div className="daystep">
      <button className="btn" aria-label="Previous day" onClick={() => onDate(addDays(date, -1))}>
        ‹
      </button>
      <label className="btn day" style={{ position: "relative" }}>
        {date === today ? `Today, ${dayLabel(date).split(", ").slice(1).join(", ")}` : dayLabel(date)}
        <input
          type="date"
          aria-label="Pick a day"
          value={date}
          max={today}
          onChange={(e) => e.target.value && onDate(e.target.value)}
          style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer" }}
        />
      </label>
      <button className="btn" aria-label="Next day" disabled={date >= today} onClick={() => onDate(addDays(date, 1))}>
        ›
      </button>
    </div>
  );
}

// Vertical bars. items: [{ value, label, tip, nodata, onClick }]; max scales the tallest.
export function Bars({ items, short = false, max }) {
  const top = max || Math.max(1, ...items.map((i) => i.value || 0));
  return (
    <div className={`bars ${short ? "short" : ""}`}>
      {items.map((it, i) => {
        const h = it.nodata ? 100 : Math.max(it.value > 0 ? 2 : 0, ((it.value || 0) / top) * 100);
        const Tag = it.onClick ? "button" : "span";
        return (
          <Tag
            key={i}
            className={`b ${it.onClick ? "click" : ""} ${it.nodata ? "nodata" : ""}`}
            onClick={it.onClick}
            aria-label={it.tip || it.label}
            style={it.nodata ? { opacity: 0.6 } : undefined}
          >
            <i style={{ height: `${h}%`, background: it.color || undefined }} />
            {it.tip && <em>{it.tip}</em>}
          </Tag>
        );
      })}
    </div>
  );
}

export function Meter({ share, color }) {
  return (
    <div className="meter">
      <span style={{ width: `${Math.max(1, Math.min(100, share * 100))}%`, background: color || undefined }} />
    </div>
  );
}

export const levelColor = { bad: "var(--bad)", warn: "var(--warn)", info: "var(--accent)", ok: "var(--ok)" };
export const healthClass = (h) => (h === "warn" ? "warn" : h === "off" ? "off" : h === "bad" ? "bad" : "");
