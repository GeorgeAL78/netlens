// Name the rule behind blocked connections stored before NetLens kept rule names (UU-C-152).
// UniFi still has its connection records for about 4 days: ask it once for the blocked ones
// in that window, match by flow id (or time + device), and fill the rule in. Runs in the
// background after a snapshot, at most hourly, and only while unnamed blocks remain.
import * as db from "./db.js";
import * as flowstore from "./flowstore.js";
import * as unifi from "./unifi.js";
import { logError } from "./log.js";

const REACH_MS = 4 * 86400e3;
let running = false;

export async function backfill(now = Date.now(), dayKeys = []) {
  if (running || process.env.NETLENS_OFFLINE === "1") return;
  if (now - Number(db.metaGet("blocked_rules_at") || 0) < 3600e3) return;
  running = true;
  try {
    const missing = flowstore.blockedWithoutRule(dayKeys, now - REACH_MS);
    db.metaSet("blocked_rules_at", now);
    if (!missing.length) return;
    const from = Math.min(...missing.map((r) => r.t)) - 60e3;
    const live = await unifi.getBlockedFlows({ startMs: from, endMs: now });
    const byId = new Map(live.filter((f) => f.id && f.policy).map((f) => [String(f.id), f.policy]));
    const byTime = new Map(live.filter((f) => f.policy).map((f) => [`${f.t}|${f.mac}`, f.policy]));
    const updates = [];
    for (const r of missing) {
      const policy = (r.id && byId.get(String(r.id))) || byTime.get(`${r.t}|${r.mac}`);
      if (policy) updates.push({ day: r.day, seq: r.seq, policy });
    }
    if (updates.length) flowstore.setPolicies(updates);
    console.log(`blocked rules: named ${updates.length} of ${missing.length} earlier blocked connections`);
  } catch (err) {
    logError("blockedrules backfill", err);
  } finally {
    running = false;
  }
}
