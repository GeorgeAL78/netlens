// Background presence (UU-C-124): every snapshot, UniFi's known devices are read (which is
// also how new ones appear) and every recently seen device UniFi does not have connected is
// checked on the network. Runs on its own — the snapshot never waits for it — and a run that
// is still going makes the next one skip.
import * as db from "./db.js";
import * as probe from "./probe.js";

const RECENT_MS = 14 * 86400e3; // older addresses are likely reassigned; not worth probing
const KEEP_MS = 90 * 86400e3;
const WORKERS = 4;
export const state = { running: false, lastRunAt: 0, checked: 0, lan: 0, changes: 0, error: null };

export async function refresh({ known, online, now = Date.now() }) {
  if (state.running) return { skipped: true };
  state.running = true;
  try {
    const onlineMacs = new Set(online.map((c) => c.mac));
    const ipOwner = new Map(online.filter((c) => c.ip).map((c) => [c.ip, c.mac]));
    let changes = 0;
    for (const mac of onlineMacs) if (db.savePresence(mac, "online", { ts: now, method: "UniFi" })) changes += 1;
    const queue = known
      .map((u) => ({ mac: String(u.mac || "").toLowerCase(), ip: u.last_ip || u.fixed_ip || null, lastSeen: (u.last_seen || 0) * 1000 }))
      .filter((d) => d.mac && !onlineMacs.has(d.mac) && d.ip && probe.isPrivateIp(d.ip) && now - d.lastSeen < RECENT_MS);
    let lan = 0;
    const worker = async () => {
      while (queue.length) {
        const d = queue.shift();
        try {
          const r = await probe.probeDevice(d.ip, d.mac, { ipOwner });
          if (r.up) lan += 1;
          if (db.savePresence(d.mac, r.up ? "lan" : "off", { ts: Date.now(), ip: d.ip, method: r.method, verify: r.verify })) changes += 1;
        } catch {
          /* one device failing must not stop the rest */
        }
      }
    };
    const total = queue.length;
    await Promise.all(Array.from({ length: WORKERS }, worker));
    db.prunePresence(now - KEEP_MS);
    Object.assign(state, { lastRunAt: now, checked: total, lan, changes, error: null });
    return { checked: total, lan, changes };
  } catch (err) {
    state.error = err.message;
    throw err;
  } finally {
    state.running = false;
  }
}
