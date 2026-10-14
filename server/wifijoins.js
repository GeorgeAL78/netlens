// Wi-Fi join attempts (UU-C-146): every time a device tried to join the Wi-Fi, whether it
// got in, and if not, where it failed — from UniFi's wifi-connectivity view (the "Failed
// Connection" rows in the UniFi app). UniFi keeps about two days; NetLens reads it with every
// update, overlapping the last read, and keeps 90 days.
import * as db from "./db.js";
import * as unifi from "./unifi.js";
import * as insights from "./insights.js";
import { logError } from "./log.js";

export const KEEP_MS = 90 * 86400e3;

// UniFi's codes in plain language, with the usual cause.
export const PROBLEMS = {
  login: {
    label: "Couldn't log in",
    hint: "Usually an old saved network or a wrong password: forget the network on the device and join again. (Smart bulbs and plugs: a WPA2-only 2.4 GHz network usually fixes it.)",
  },
  refused: {
    label: "Access point refused it",
    hint: "Weak signal, or a band or security setting the device does not support.",
  },
  noip: {
    label: "Got no IP address",
    hint: "The device joined but DHCP did not answer — check the network's DHCP range is not full.",
  },
  dns: {
    label: "Joined, but DNS failed",
    hint: "Its first name lookup timed out. Common with a work VPN or company DNS; usually harmless.",
  },
  other: { label: "Failed to join", hint: "" },
};

export function problemOf(reason) {
  const r = String(reason || "").toUpperCase();
  if (r === "SUCCESS") return null;
  if (/AUTH/.test(r)) return "login";
  if (/ASSOC/.test(r)) return "refused";
  if (/DHCP/.test(r)) return "noip";
  if (/DNS/.test(r)) return "dns";
  return "other";
}

let running = false;
export const state = { lastRunAt: 0, error: null, saved: 0 };

export async function refresh(now = Date.now()) {
  if (running) return;
  running = true;
  try {
    const newest = db.newestWifiJoin();
    // Overlap the last read by 20 minutes; at most what UniFi still has (~2 days, asked for 3).
    const from = Math.max(now - 3 * 86400e3, newest ? newest - 20 * 60e3 : 0);
    const json = await unifi.getWifiConnectivity({ startMs: from, endMs: now });
    const rows = new Map();
    for (const g of json?.event_groups || []) {
      const mac = String(g.client?.mac || "").toLowerCase();
      if (!mac) continue;
      for (const e of g.events || []) {
        const ts = Number(e.start_time);
        if (!ts) continue;
        const ap = String(e.ap_mac || "").toLowerCase();
        const result = String(e.failure_reason || "UNKNOWN");
        // UniFi logs some failures twice in the same second: one row, counted.
        const key = `${mac}|${ts}|${ap}|${result}`;
        const r = rows.get(key) || { mac, ts, ap, result, stage: g.failure_stage || null, latencyMs: e.latency != null ? Math.round(Number(e.latency) / 1000) : null, n: 0 };
        r.n += 1;
        rows.set(key, r);
      }
    }
    db.saveWifiJoins([...rows.values()]);
    db.pruneWifiJoins(now - KEEP_MS);
    Object.assign(state, { lastRunAt: now, error: null, saved: rows.size });
  } catch (err) {
    state.error = err.message;
    logError("wifijoins refresh", err);
  } finally {
    running = false;
  }
}

// Per device: joins, failures by problem, access points, typical join time, last failure.
export function summary(from, to, mac = null) {
  const nameOf = insights.names();
  const devices = new Map();
  for (const r of db.wifiJoins(from, to, mac)) {
    let d = devices.get(r.mac);
    if (!d) {
      d = { mac: r.mac, name: nameOf(r.mac), joins: 0, fails: 0, lastFail: null, lastJoin: null, latencies: [], problems: {} };
      devices.set(r.mac, d);
    }
    const p = problemOf(r.result);
    if (!p) {
      d.joins += r.n;
      d.lastJoin = Math.max(d.lastJoin || 0, r.ts);
      if (r.latencyMs != null) d.latencies.push(r.latencyMs);
      continue;
    }
    d.fails += r.n;
    d.lastFail = Math.max(d.lastFail || 0, r.ts);
    const x = (d.problems[p] ||= { key: p, label: PROBLEMS[p].label, hint: PROBLEMS[p].hint, n: 0, last: 0, aps: {} });
    x.n += r.n;
    x.last = Math.max(x.last, r.ts);
    const apName = r.ap ? nameOf(r.ap) : "unknown access point";
    x.aps[apName] = (x.aps[apName] || 0) + r.n;
  }
  return [...devices.values()]
    .map(({ latencies, problems, ...d }) => {
      const sorted = latencies.sort((a, b) => a - b);
      return {
        ...d,
        joinMs: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
        problems: Object.values(problems)
          .map((x) => ({ ...x, aps: Object.entries(x.aps).sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n })) }))
          .sort((a, b) => b.n - a.n),
      };
    })
    .sort((a, b) => b.fails - a.fails || b.joins - a.joins);
}

// One device's failed attempts, newest first, for its event list.
export function failures(from, to, mac, limit = 200) {
  const nameOf = insights.names();
  return db
    .wifiJoins(from, to, mac)
    .filter((r) => problemOf(r.result))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit)
    .map((r) => ({ ts: r.ts, n: r.n, problem: problemOf(r.result), label: PROBLEMS[problemOf(r.result)].label, code: r.result, ap: r.ap ? nameOf(r.ap) : null }));
}
