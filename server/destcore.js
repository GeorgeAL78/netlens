// What each device talked to in many time windows (UU-C-208): the core of
// flowstore.destinationsMany, kept free of side effects so worker threads can run it on their
// own read-only connection to flows.db (destpool.js).
//
// items [{ mac, from, to }] → one list of { domain, bytes } per item, in order: the top `limit`
// destinations by bytes in [from, to], equal bytes ranked by first appearance in (t, day, seq)
// order. Each device's rows inside the union of its windows are read once, in the covering
// index's order, and every window is summed from them.
const inList = (a) => a.map(() => "?").join(",");

export function destinationsWith(db, days, items, limit = 3) {
  const out = items.map(() => []);
  if (!days.length || !items.length) return out;
  const byMac = new Map();
  items.forEach((it, i) => {
    if (!byMac.has(it.mac)) byMac.set(it.mac, []);
    byMac.get(it.mac).push(i);
  });
  const stmt = db.prepare(
    `SELECT t, domain, bytes FROM flows INDEXED BY flows_dest
     WHERE mac = ? AND t >= ? AND t <= ? AND t > 0 AND day IN (${inList(days)})
     ORDER BY t, day, seq`
  );
  // Rows as [t, domain, bytes] arrays: about half the cost of an object per row.
  stmt.setReturnArrays?.(true);
  for (const [mac, idx] of byMac) {
    idx.sort((a, b) => items[a].from - items[b].from);
    // Merge overlapping windows so no row is read twice.
    const spans = [];
    for (const i of idx) {
      const { from, to } = items[i];
      const last = spans[spans.length - 1];
      if (last && from <= last.to) last.to = Math.max(last.to, to);
      else spans.push({ from, to });
    }
    const t = [];
    const dom = [];
    const by = [];
    for (const s of spans) {
      for (const r of stmt.all(mac, s.from, s.to, ...days)) {
        const arr = Array.isArray(r);
        t.push(arr ? r[0] : r.t);
        dom.push(arr ? r[1] : r.domain);
        by.push((arr ? r[2] : r.bytes) || 0);
      }
    }
    // Spans are disjoint and ascending, so `t` is sorted: binary search each window's start.
    for (const i of idx) {
      const { from, to } = items[i];
      let lo = 0;
      let hi = t.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (t[mid] < from) lo = mid + 1;
        else hi = mid;
      }
      const sums = new Map();
      for (let k = lo; k < t.length && t[k] <= to; k++) {
        const d = dom[k];
        const cur = sums.get(d);
        if (cur) cur.bytes += by[k];
        else sums.set(d, { domain: d, bytes: by[k], first: k });
      }
      out[i] = [...sums.values()]
        .sort((a, b) => b.bytes - a.bytes || a.first - b.first)
        .slice(0, limit)
        .map(({ domain, bytes }) => ({ domain, bytes }));
    }
  }
  return out;
}
