import { useEffect, useMemo, useRef, useState } from "react";
import { addDays, dayLabel, todayKey, useApi } from "./lib.js";

// A month calendar (UU-C-096). Days with saved data carry a dot; future days are disabled.
const WEEK = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const pad = (n) => String(n).padStart(2, "0");

export function Calendar({ value, onPick, onClose }) {
  const today = todayKey();
  const [month, setMonth] = useState((value || today).slice(0, 7));
  const box = useRef(null);
  const cache = useApi("/api/cache");
  const saved = new Set((cache.data?.keys || []).filter((k) => k.fetchedAt).map((k) => k.key));
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const out = (e) => box.current && !box.current.contains(e.target) && close.current();
    const esc = (e) => e.key === "Escape" && close.current();
    // After the click that opened it, so that click does not close it again.
    const t = setTimeout(() => document.addEventListener("mousedown", out), 0);
    document.addEventListener("keydown", esc);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", out);
      document.removeEventListener("keydown", esc);
    };
  }, []);
  const [y, m] = month.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const lead = (first.getDay() + 6) % 7; // Monday first
  const count = new Date(y, m, 0).getDate();
  const cells = [...Array(lead).fill(null), ...Array.from({ length: count }, (_, i) => `${month}-${pad(i + 1)}`)];
  const shift = (n) => {
    const d = new Date(y, m - 1 + n, 1);
    setMonth(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
  };
  const title = first.toLocaleDateString([], { month: "long", year: "numeric" });
  return (
    <div className="calendar" ref={box} role="dialog" aria-label="Pick a day">
      <div className="cal-head">
        <button className="iconbtn" aria-label="Previous month" onClick={() => shift(-1)}>‹</button>
        <strong>{title}</strong>
        <button className="iconbtn" aria-label="Next month" disabled={month >= today.slice(0, 7)} onClick={() => shift(1)}>›</button>
      </div>
      <div className="cal-grid">
        {WEEK.map((w) => <span key={w} className="cal-dow">{w}</span>)}
        {cells.map((k, i) =>
          k ? (
            <button
              key={k}
              className={`cal-day ${k === value ? "on" : ""} ${k === today ? "today" : ""} ${saved.has(k) ? "has" : ""}`}
              disabled={k > today}
              onClick={() => onPick(k)}
              title={saved.has(k) ? "Saved data" : k > today ? "" : "No saved data"}
            >
              {Number(k.slice(8))}
            </button>
          ) : (
            <span key={`e${i}`} />
          )
        )}
      </div>
      <div className="cal-foot">
        <span className="dim small"><i className="cal-dot" /> saved data</span>
        <button className="btn small" onClick={() => onPick(today)}>Today</button>
      </div>
    </div>
  );
}

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
export function DayStep({ date, onDate, openAtStart = false }) {
  const today = todayKey();
  const [open, setOpen] = useState(openAtStart);
  return (
    <div className="daystep">
      <button className="btn" aria-label="Previous day" onClick={() => onDate(addDays(date, -1))}>
        ‹
      </button>
      <span style={{ position: "relative" }}>
        <button className="btn day" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {date === today ? `Today, ${dayLabel(date).split(", ").slice(1).join(", ")}` : dayLabel(date)}
        </button>
        {open && (
          <Calendar
            value={date}
            onClose={() => setOpen(false)}
            onPick={(k) => {
              setOpen(false);
              onDate(k);
            }}
          />
        )}
      </span>
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

// Type-ahead finder (UU-C-112): one box over grouped items — apps, categories, devices.
// groups: [{ label, items: [{ key, label, sub, on, pick }] }]. With `browse`, focusing the
// empty box lists everything; without it (the top bar) results appear once you type.
export function Finder({ groups, placeholder, browse = false, className = "" }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const box = useRef(null);
  useEffect(() => {
    const close = (e) => box.current && !box.current.contains(e.target) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s && !browse) return [];
    return groups
      .filter((g) => s || !g.searchOnly) // e.g. old unnamed addresses: only when typed for
      .map((g) => ({ ...g, items: g.items.filter((i) => !s || [i.label, i.sub, ...(i.searchable || [])].join(" ").toLowerCase().includes(s)).slice(0, s ? 12 : 40) }))
      .filter((g) => g.items.length);
  }, [q, groups, browse]);
  const flat = shown.flatMap((g) => g.items);
  const pick = (i) => {
    setOpen(false);
    setQ("");
    i.pick();
  };
  return (
    <div className={`search ${className}`} ref={box}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <circle cx="11" cy="11" r="6" />
        <path d="M20 20l-4.5-4.5" />
      </svg>
      <input
        aria-label={placeholder}
        placeholder={placeholder}
        value={q}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQ(e.target.value);
          setSel(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setSel((i) => Math.min(i + 1, flat.length - 1));
          else if (e.key === "ArrowUp") setSel((i) => Math.max(i - 1, 0));
          else if (e.key === "Enter" && flat[sel]) pick(flat[sel]);
          else if (e.key === "Escape") setOpen(false);
        }}
      />
      {open && (q.trim() || browse) && (
        <div className="search-results" role="listbox">
          {!groups.some((g) => g.items.length) && <div className="dim small" style={{ padding: 10 }}>Loading…</div>}
          {groups.some((g) => g.items.length) && !flat.length && <div className="dim small" style={{ padding: 10 }}>Nothing matches “{q}”.</div>}
          {!q.trim() &&
            groups
              .filter((g) => g.searchOnly && g.items.length)
              .map((g) => (
                <div key={`more-${g.label}`} className="dim small" style={{ padding: "8px 10px" }}>
                  +{g.items.length} {g.label.toLowerCase()} — type to search
                </div>
              ))}
          {shown.map((g) => (
            <div key={g.label}>
              <div className="grp">{g.label}</div>
              {g.items.map((i) => {
                const n = flat.indexOf(i);
                return (
                  <a
                    key={i.key}
                    href="#"
                    role="option"
                    aria-selected={n === sel}
                    className={`${n === sel ? "on" : ""} ${i.on ? "picked" : ""}`}
                    onMouseEnter={() => setSel(n)}
                    onClick={(e) => {
                      e.preventDefault();
                      pick(i);
                    }}
                  >
                    <span className="ellipsis">{i.label}</span>
                    {i.sub && <span className="dim small">{i.sub}</span>}
                  </a>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
