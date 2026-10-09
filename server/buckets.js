import * as unifi from "./unifi.js";

// Five-minute DPI buckets: how much each device sent to each app, and when.
//
// This is what the hourly chart, the session list and the Apps table all share, so the
// numbers on one screen come from one source. Before this, the chart and sessions were
// rebuilt from flow records matched to the DPI app by name, and 83% of device/app/day
// selections drew an empty chart (UU-C-043).
//
// Three measured facts about UniFi's `traffic` endpoint shape this (Network 10.6.106):
//   * It keeps 5-minute DPI buckets for about a day. A one-hour window 25 h back returns
//     nothing; older days exist only as daily totals.
//   * It drops whatever sits on a window edge. 09:54-10:06 held 413 MB of App Store
//     download, yet neither 09:00-10:00 nor 10:00-11:00 contained it, and hour windows
//     starting exactly on the hour came back empty. Adjacent windows therefore do NOT
//     add up.
//   * Cumulative windows from one fixed anchor do. Differencing F(anchor, t) at 5-minute
//     steps reproduced the day total to the byte (513.4 MB, 134.82 GB) and put the
//     download at 10:00-10:05, matching its flow records.
export const BUCKET_MS = 5 * 60 * 1000;
// Stay inside UniFi's ~24 h of 5-minute data, with margin for a slow fetch.
export const BUCKET_REACH_MS = 23 * 60 * 60 * 1000;

function readCumulative(rows) {
  const out = new Map();
  for (const c of rows) {
    const mac = c.client.mac;
    for (const u of c.usage) {
      out.set(`${mac}|${u.catId}|${u.appId}`, {
        mac,
        appId: u.appId,
        catId: u.catId,
        rx: u.bytesRx,
        tx: u.bytesTx,
        act: u.activitySeconds,
      });
    }
  }
  return out;
}

// Rows are [bucketStart, mac, appId, catId, bytesRx, bytesTx, activitySeconds, stepMs?];
// stepMs is absent for 5-minute rows and HOUR_MS for hourly history.
export async function fetchBuckets(fromMs, toMs) {
  const from = Math.ceil(fromMs / BUCKET_MS) * BUCKET_MS;
  const to = Math.floor(toMs / BUCKET_MS) * BUCKET_MS;
  if (!(to > from)) return { rows: [], from, to: from };
  // The endpoint rounds a window's start up to the next hour, so the anchor sits just
  // before the hour containing `from`: an anchor inside that hour would silently drop
  // the rest of it from every read. The same anchor for every read cancels out of the
  // differences.
  const anchor = Math.floor(from / (60 * 60 * 1000)) * 60 * 60 * 1000 - 1;
  let prev = readCumulative(await unifi.getTraffic(anchor, from));
  // DPI relabels traffic after the fact (Unknown becomes the real app), so a key's
  // cumulative value can fall: 135 of ~22k differences over 23 h, 2.8 GB. A bar can't be
  // negative, so the shortfall is carried and taken from later buckets of the same key,
  // then from earlier ones if it is still owed at the end — the per-key total stays exact.
  const owed = new Map();
  const byKey = new Map();
  const rows = [];
  for (let t = from + BUCKET_MS; t <= to; t += BUCKET_MS) {
    const cur = readCumulative(await unifi.getTraffic(anchor, t));
    // A key that vanished dropped to zero: DPI moved its bytes to another key, which
    // jumps by the same amount. Keeping the old value counted them twice — 2 GB on one
    // device in a day. The carry below evens it out if the key comes back.
    const ZERO = { rx: 0, tx: 0, act: 0 };
    for (const k of new Set([...cur.keys(), ...prev.keys()])) {
      const c = cur.get(k) || { ...prev.get(k), ...ZERO };
      const p = prev.get(k);
      const o = owed.get(k) || { rx: 0, tx: 0, act: 0 };
      const d = {
        rx: c.rx - (p?.rx || 0) + o.rx,
        tx: c.tx - (p?.tx || 0) + o.tx,
        act: c.act - (p?.act || 0) + o.act,
      };
      owed.set(k, { rx: Math.min(0, d.rx), tx: Math.min(0, d.tx), act: Math.min(0, d.act) });
      const rx = Math.max(0, d.rx);
      const tx = Math.max(0, d.tx);
      const act = Math.max(0, d.act);
      if (rx + tx <= 0) continue;
      const row = [t - BUCKET_MS, c.mac, c.appId, c.catId, rx, tx, act];
      rows.push(row);
      const list = byKey.get(k);
      if (list) list.push(row);
      else byKey.set(k, [row]);
    }
    prev = cur;
  }
  for (const [k, o] of owed) {
    const list = byKey.get(k) || [];
    let rx = -o.rx;
    let tx = -o.tx;
    for (let i = list.length - 1; i >= 0 && (rx > 0 || tx > 0); i -= 1) {
      const take = Math.min(rx, list[i][4]);
      list[i][4] -= take;
      rx -= take;
      const takeTx = Math.min(tx, list[i][5]);
      list[i][5] -= takeTx;
      tx -= takeTx;
    }
  }
  return { rows: rows.filter((r) => r[4] + r[5] > 0), from, to };
}

export const HOUR_MS = 60 * 60 * 1000;

// Hourly detail for a finished day, plus its correct total.
//
// Two measured rules of the endpoint shape this:
//   * A window's START is rounded up to the next hour — even a start exactly on the hour
//     drops that hour. Every day total stored before UU-C-043 began at midnight and so
//     lacked 00:00-01:00 (0.7-13.3% of the day, 3.03 GB on Sep 19). The day's own total
//     is read from midnight - 1 ms.
//   * On older data, the first ~6 hours after a cumulative anchor come back as one lump.
//     Anchored at midnight, 00-05 read as zero and 06:00 carried the block, so every
//     past day showed a blank morning (UU-F-048). Anchored 12 h or 24 h earlier, those
//     hours resolve individually and agree with each other exactly (Sep 20: 0.6 2.1 0.2
//     0.6 1.5 2.6 1.5 GB for 00-06 either way). So the anchor sits 12 h back and the
//     lead-in is subtracted.
// Returns hourly rows and the day's raw traffic rows (its total, from midnight - 1).
const LEAD_IN_MS = 12 * HOUR_MS;

export async function fetchHourly(dayStart, dayEnd) {
  const anchor = dayStart - LEAD_IN_MS - 1;
  let prev = readCumulative(await unifi.getTraffic(anchor, dayStart - 1));
  const rows = [];
  for (let t = dayStart + HOUR_MS; t <= dayEnd; t += HOUR_MS) {
    const cur = readCumulative(await unifi.getTraffic(anchor, t - 1));
    for (const [k, c] of cur) {
      const p = prev.get(k);
      const rx = Math.max(0, c.rx - (p?.rx || 0));
      const tx = Math.max(0, c.tx - (p?.tx || 0));
      if (rx + tx <= 0) continue;
      rows.push([t - HOUR_MS, c.mac, c.appId, c.catId, rx, tx, Math.max(0, c.act - (p?.act || 0)), HOUR_MS]);
    }
    prev = cur;
  }
  const traffic = await unifi.getTraffic(dayStart - 1, dayEnd - 1);
  return { rows, blockEnd: dayStart, traffic };
}
