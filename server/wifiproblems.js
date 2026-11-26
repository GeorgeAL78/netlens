// Wi-Fi problems from the access points' own logs (UU-C-299): why a device left, DNS lookups
// that timed out, and the anomalies UniFi's access points flag per device. Read from
// siem_events kind 'ap' (written by siem.js); never from UniFi on the request path.
import * as db from "./db.js";
import * as insights from "./insights.js";

// 802.11 reason codes (IEEE 802.11 table 9-49), the ones a home network sees.
const REASON = {
  1: "unspecified reason",
  2: "its sign-in was no longer valid",
  3: "it left the network",
  4: "inactive for too long",
  5: "the access point had too many devices",
  6: "sent data before signing in",
  7: "sent data before joining",
  8: "it left on its own",
  9: "not signed in",
  14: "message check failed",
  15: "the Wi-Fi password handshake timed out",
  16: "the group key handshake timed out",
  17: "security settings changed",
  23: "802.1X sign-in failed",
  34: "too many lost frames (poor signal)",
};
// What a leave means in words: the device's choice or the access point's.
export function leaveText(d) {
  const code = d?.code;
  const own = /sta left/i.test(d?.reason || "") || code === 3 || code === 8;
  const why = REASON[code] || (d?.reason ? String(d.reason) : code != null ? `reason ${code}` : "no reason given");
  return { own, text: own ? "left on its own" : `removed by the access point: ${why}`, why, code: code ?? null };
}

const ANOMALY = {
  dns_timeout: "DNS lookups timing out",
  tcp_latency: "slow responses (TCP latency)",
  high_tcp_latency: "slow responses (TCP latency)",
  tcp_packet_loss: "lost packets",
  high_tcp_packet_loss: "lost packets",
  low_rssi: "weak signal",
  sticky_client: "stays on a far access point",
  high_wifi_retries: "many Wi-Fi retries",
  high_wifi_latency: "slow Wi-Fi responses",
  dhcp_timeout: "address requests timing out",
  arp_timeout: "gateway not answering",
};
export const anomalyText = (k) => ANOMALY[k] || String(k || "").replace(/_/g, " ");

const apName = (nameOf, d) => (d?.apMac ? nameOf(d.apMac) : null) || d?.ap || "an access point";
const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

// One device's problems in [start, end).
export function forDevice(mac, start, end) {
  const nameOf = insights.names();
  const rows = db.apEvents(start, end, String(mac).toLowerCase());
  const leaves = [];
  const dns = { events: 0, timeouts: 0, last: null, aps: new Set() };
  const kinds = new Map();
  const recent = [];
  for (const e of rows) {
    const d = e.data || {};
    const ap = apName(nameOf, d);
    if (e.category === "leave") {
      const t = leaveText(d);
      leaves.push({ ts: e.ts, ap, ...t, rssi: d.rssi ?? null });
      recent.push({ ts: e.ts, kind: "leave", what: t.own ? "Left Wi-Fi" : "Removed from Wi-Fi", detail: [ap, t.own ? null : t.why, d.rssi != null ? `${d.rssi} dBm before` : null].filter(Boolean).join(" · "), level: t.own ? "info" : "warn" });
    } else if (e.category === "dns") {
      dns.events += 1;
      dns.timeouts += Number(d.n) || 1;
      dns.last = Math.max(dns.last || 0, e.ts);
      dns.aps.add(ap);
      recent.push({ ts: e.ts, kind: "dns", what: `DNS timed out ${d.n || 1}×`, detail: ap, level: "warn" });
    } else if (e.category === "anomaly") {
      for (const a of d.anomalies || []) {
        const k = kinds.get(a) || { key: a, label: anomalyText(a), n: 0, last: 0, signals: [], satisfaction: null, aps: new Set() };
        k.n += 1;
        k.last = Math.max(k.last, e.ts);
        if (d.signal != null) k.signals.push(d.signal);
        if (d.satisfaction != null) k.satisfaction = k.satisfaction == null ? d.satisfaction : Math.min(k.satisfaction, d.satisfaction);
        k.aps.add(ap);
        kinds.set(a, k);
      }
      recent.push({ ts: e.ts, kind: "anomaly", what: (d.anomalies || []).map(anomalyText).join(", "), detail: [ap, d.signal != null ? `${d.signal} dBm` : null, d.satisfaction != null ? `satisfaction ${d.satisfaction}%` : null].filter(Boolean).join(" · "), level: "warn" });
    } else {
      recent.push({ ts: e.ts, kind: "other", what: e.name, detail: ap, level: "info" });
    }
  }
  return {
    leaves,
    dns: { events: dns.events, timeouts: dns.timeouts, last: dns.last, aps: [...dns.aps] },
    anomalies: [...kinds.values()].sort((a, b) => b.n - a.n).map((k) => ({ key: k.key, label: k.label, n: k.n, last: k.last, signal: avg(k.signals), satisfaction: k.satisfaction, aps: [...k.aps] })),
    recent: recent.slice(0, 60),
    more: Math.max(0, recent.length - 60),
  };
}

// The leave nearest a disconnect (within 2 minutes), for the Wi-Fi history.
export function leavesNear(mac, start, end) {
  const rows = db.apEvents(start - 120e3, end + 120e3, String(mac).toLowerCase(), "leave");
  return (ts) => {
    let best = null;
    for (const r of rows) if (Math.abs(r.ts - ts) <= 120e3 && (!best || Math.abs(r.ts - ts) < Math.abs(best.ts - ts))) best = r;
    return best ? { ...leaveText(best.data), rssi: best.data?.rssi ?? null } : null;
  };
}

// Per device in [start, end): DNS timeouts and anomaly counts, for Overview.
export function summary(start, end) {
  const nameOf = insights.names();
  const by = new Map();
  for (const e of db.apEvents(start, end)) {
    if (e.category !== "dns" && e.category !== "anomaly") continue;
    const s = by.get(e.mac) || { mac: e.mac, name: nameOf(e.mac), dnsEvents: 0, timeouts: 0, anomalies: 0, last: 0, signals: [], aps: new Set() };
    if (e.category === "dns") {
      s.dnsEvents += 1;
      s.timeouts += Number(e.data?.n) || 1;
    } else {
      s.anomalies += 1;
      if (e.data?.signal != null) s.signals.push(e.data.signal);
    }
    s.last = Math.max(s.last, e.ts);
    s.aps.add(apName(nameOf, e.data));
    by.set(e.mac, s);
  }
  return [...by.values()].map((s) => ({ ...s, signal: avg(s.signals), aps: [...s.aps], signals: undefined }));
}
