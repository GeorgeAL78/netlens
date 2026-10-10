import * as db from "./db.js";
import * as insights from "./insights.js";
import { sessionize } from "./classify.js";

// Read-only views for the redesigned interface (UU-C-087): the day grid, the network map and
// the findings feed. Like /api/report they read SQLite and the cache only — never UniFi.

const HOUR = 3600000;
const isMac = (v) => /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(String(v || "").toLowerCase());
const lower = (v) => String(v || "").toLowerCase();

// Latest client sample per MAC within [start, end).
function latestSamples(start, end) {
  const last = new Map();
  for (const r of db.queryClientSamples(start, end, null)) last.set(r.mac, r);
  return last;
}

function linkOf(r, nameOf) {
  if (!r) return null;
  return r.wired
    ? { wired: true, ip: r.ip ?? null, via: r.ap_mac ? nameOf(r.ap_mac) : null, port: r.port ?? null, speed: r.tx_rate != null ? Math.round(r.tx_rate / 1000) : null, uptime: r.uptime ?? null, ts: r.ts }
    : { wired: false, ip: r.ip ?? null, via: r.ap_mac ? nameOf(r.ap_mac) : null, signal: r.signal ?? null, radio: r.radio || null, essid: r.essid || null, uptime: r.uptime ?? null, ts: r.ts };
}

function healthOf(link, now, today) {
  if (!link) return "off";
  if (today && now - link.ts > 15 * 60 * 1000) return "off";
  if (link.wired) return link.speed != null && link.speed <= 100 ? "warn" : "ok";
  return link.signal != null && link.signal < -80 ? "warn" : "ok";
}

// Event markers per device and hour: roams/connects and blocked traffic.
function markersFor(start, end) {
  const marks = new Map();
  const add = (mac, ts, kind) => {
    if (!mac) return;
    const h = Math.floor((ts - start) / HOUR);
    if (h < 0 || h > 23) return;
    const m = marks.get(mac) || Array.from({ length: 24 }, () => ({ roam: 0, conn: 0, block: 0 }));
    m[h][kind] += 1;
    marks.set(mac, m);
  };
  for (const e of db.querySiemEvents(start, end, null)) {
    if (e.kind !== "log") continue;
    const key = e.data?.key || "";
    if (/ROAMED/.test(key)) add(e.mac, e.ts, "roam");
    else if (/CONNECTED|DISCONNECTED/.test(key)) add(e.mac, e.ts, "conn");
    else if (/^THREAT_|^TRAFFIC_BLOCKED/.test(key)) add(lower(e.data?.params?.SRC_CLIENT?.i) || e.mac, e.ts, "block");
  }
  return marks;
}

// ---- Day: every device as a row, the day's 24 hours as columns --------------------------
export function dayGrid({ bundle, start, end, now, today }) {
  const nameOf = insights.names();
  const hourly = new Map();
  for (const b of bundle.buckets) {
    if (b[0] < start || b[0] >= end) continue;
    const h = Math.floor((b[0] - start) / HOUR);
    if (h < 0 || h > 23) continue;
    const arr = hourly.get(b[1]) || new Array(24).fill(0);
    arr[h] += b[4] + b[5];
    hourly.set(b[1], arr);
  }
  const totals = new Map();
  // UniFi's usage record says wired or Wi-Fi for every day, even days NetLens took no
  // samples (before it was installed, or while it was off).
  const wiredFlag = new Map();
  for (const c of bundle.traffic) {
    totals.set(c.client.mac, c.usage.reduce((n, u) => n + (u.totalBytes || u.bytesRx + u.bytesTx), 0));
    if (typeof c.client.wired === "boolean") wiredFlag.set(c.client.mac, c.client.wired);
  }
  // Hours with 5-minute or hourly detail; the rest is "no data", never a quiet hour.
  const spans = bundle.bucketSpans;
  const detail = Array.from({ length: 24 }, (_, h) => {
    const a = start + h * HOUR;
    const b = Math.min(a + HOUR, now);
    if (b <= a) return null; // later today
    const covered = spans.reduce((n, [x, y]) => n + Math.max(0, Math.min(b, y) - Math.max(a, x)), 0);
    return covered / (b - a) >= 0.5;
  });
  const marks = markersFor(start, end);
  const samples = latestSamples(start, end);
  const logs = insights.logHistory(start, end, null, now);
  const storedIp = new Map(db.listStoredClients().filter((c) => c.ip).map((c) => [String(c.mac).toLowerCase(), c.ip]));
  const macs = new Set([...totals.keys(), ...hourly.keys(), ...marks.keys()]);
  const rows = [...macs].map((mac) => {
    const sampled = linkOf(samples.get(mac), nameOf);
    // No samples that day: the System Log's last word on where it was attached, unless the
    // day's usage record says the other link type (then the log is stale).
    const logged = logs.get(mac)?.link;
    const flag = wiredFlag.get(mac);
    const link =
      sampled ||
      (logged && (flag === undefined || flag === logged.wired) ? { ...logged, unsampled: true } : null) ||
      (flag !== undefined ? { wired: flag, unsampled: true } : null);
    // IP that day: a sample, else the day's System Log; failing both the last one known.
    const dayIp = sampled?.ip || logs.get(mac)?.link?.ip || null;
    const lastIp = dayIp ? null : logs.get(mac)?.link?.priorIp || storedIp.get(mac) || null;
    return {
      mac,
      name: nameOf(mac),
      ip: dayIp || lastIp,
      ipLastKnown: !dayIp && Boolean(lastIp),
      link,
      // Past days with only the log: judged on the logged signal; today it needs a sample.
      health: sampled ? healthOf(sampled, now, today) : !today && link?.via ? healthOf(link, now, false) : "off",
      hourly: hourly.get(mac) || new Array(24).fill(0),
      marks: marks.get(mac) || null,
      total: totals.get(mac) || (hourly.get(mac) || []).reduce((n, v) => n + v, 0),
    };
  });
  rows.sort((a, b) => b.total - a.total);
  const network = new Array(24).fill(0);
  for (const r of rows) r.hourly.forEach((v, i) => (network[i] += v));
  return {
    hours: Array.from({ length: 24 }, (_, h) => start + h * HOUR),
    detail,
    network: { hourly: network, total: rows.reduce((n, r) => n + r.total, 0) },
    rows,
  };
}

// ---- Network: gateway → switches / access points → devices ------------------------------
export function networkMap({ bundle, now }) {
  const nameOf = insights.names();
  const recent = latestSamples(now - 15 * 60 * 1000, now + 1);
  // Traffic in the last 15 minutes per device, as a rate.
  const rate = new Map();
  for (const b of bundle.buckets) {
    if (b[0] < now - 15 * 60 * 1000) continue;
    rate.set(b[1], (rate.get(b[1]) || 0) + b[4] + b[5]);
  }
  const devices = db.latestDeviceSamples();
  const gateway = devices.find((d) => /udm|ugw|uxg/.test(d.type || "")) || null;
  const infra = devices.filter((d) => d !== gateway);
  const node = (d) => ({
    mac: d.mac,
    name: d.name || d.model,
    type: d.type,
    model: d.model,
    online: d.state === 1,
    cpu: d.cpu,
    mem: d.mem,
    temp: d.temp,
    uptime: d.uptime,
    radios: d.data?.radios || [],
    ports: d.data?.ports || [],
    uplink: d.data?.uplink || null,
    clients: [],
  });
  const nodes = new Map();
  if (gateway) nodes.set(gateway.mac, node(gateway));
  for (const d of infra) nodes.set(d.mac, node(d));
  const loose = [];
  for (const [mac, r] of recent) {
    const link = linkOf(r, nameOf);
    const c = {
      mac,
      name: nameOf(mac),
      wired: Boolean(r.wired),
      port: r.port ?? null,
      speed: link.speed ?? null,
      signal: link.signal ?? null,
      radio: r.radio || null,
      essid: r.essid || null,
      uptime: r.uptime ?? null,
      bytes15m: rate.get(mac) || 0,
      health: healthOf(link, now, true),
    };
    const parent = nodes.get(r.ap_mac);
    if (parent) parent.clients.push(c);
    else loose.push(c);
  }
  for (const n of nodes.values()) n.clients.sort((a, b) => b.bytes15m - a.bytes15m || String(a.name).localeCompare(String(b.name)));
  const wan = db.latestWanSample();
  return {
    wan: wan ? { status: wan.status, isp: wan.isp, latency: wan.latency, availability: wan.availability, rxRate: wan.rx_rate, txRate: wan.tx_rate, ts: wan.ts } : null,
    gateway: gateway ? nodes.get(gateway.mac) : null,
    nodes: [...nodes.values()].filter((n) => !gateway || n.mac !== gateway.mac),
    loose,
  };
}

// ---- Home: findings, in plain language ----------------------------------------------------
const GB = 1e9;
const fmtGB = (b) => (b >= GB ? `${(b / GB).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);

export function findings({ bundle, start, end, now, lostSpans, clock, appName, catName = () => "", dayKey, today, days }) {
  const when = today ? "today" : days ? `in these ${days} days` : "that day";
  const nameOf = insights.names();
  const out = [];
  const totalDay = bundle.traffic.reduce((n, c) => n + c.usage.reduce((m, u) => m + (u.totalBytes || u.bytesRx + u.bytesTx), 0), 0);

  // Plumbing (protocols, CDNs, unclassified) is not "an app" in a sentence (UU-C-127).
  const plumbing = (app, cat) =>
    !/^Calls\b/.test(app) && (/^(Network protocols|Unknown)$/.test(cat || "") || /^(HTTPS?|SSL\/TLS|DTLS|QUIC|DNS|Unidentified)$|\b(CDN|Akamai|CloudFront|Cloudflare|Fastly|Static Content|User Content|APIs?)\b/i.test(app));
  const nDays = days ? Number(days) : 1; // a range runs from midnight days-1 ago to now
  // Bars for a card: hours for one day, days for a range (UU-C-127).
  const barsFor = (mac) => {
    const n = days ? nDays : 24;
    const step = days ? 24 * HOUR : HOUR;
    const v = new Array(n).fill(0);
    for (const b of bundle.buckets) if (b[1] === mac && b[0] >= start && b[0] < end) v[Math.max(0, Math.min(n - 1, Math.floor((b[0] - start) / step)))] += b[4] + b[5];
    return v;
  };

  // Per device and per app over the period, from UniFi's usage (the Usage page's numbers).
  const byDevice = new Map();
  const byApp = new Map();
  for (const c of bundle.traffic) {
    const mac = c.client.mac;
    for (const u of c.usage) {
      const b = u.totalBytes || u.bytesRx + u.bytesTx;
      const app = appName(u.appId, u.catId);
      const cat = catName(u.catId);
      const d = byDevice.get(mac) || { mac, bytes: 0, apps: new Map(), other: new Map() };
      d.bytes += b;
      (plumbing(app, cat) ? d.other : d.apps).set(app, (d.apps.get(app) || d.other.get(app) || 0) + b);
      byDevice.set(mac, d);
      if (!plumbing(app, cat)) {
        const a = byApp.get(app) || { app, cat, bytes: 0, devices: new Map() };
        a.bytes += b;
        a.devices.set(mac, (a.devices.get(mac) || 0) + b);
        byApp.set(app, a);
      }
    }
  }
  const mainApp = (d) => [...(d?.apps || new Map()).entries()].sort((x, y) => y[1] - x[1])[0]?.[0] || null;
  // No real app: say what the traffic is — unidentified usually means a VPN (WireGuard).
  const whatItIs = (d) => {
    const top = [...(d?.other || new Map()).entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
    return top === "Unidentified" || !top ? "unidentified — VPN or encrypted" : top;
  };
  const pct = (b) => (totalDay ? Math.round((b / totalDay) * 100) : 0);
  const topDevices = [...byDevice.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 5);
  if (topDevices.length > 1) {
    out.push({
      id: `top-devices-${start}`,
      kind: "usage",
      level: "info",
      ts: start,
      title: `Top devices ${when}: ${nameOf(topDevices[0].mac)} ${fmtGB(topDevices[0].bytes)}, ${nameOf(topDevices[1].mac)} ${fmtGB(topDevices[1].bytes)}${topDevices[2] ? ", …" : ""}`,
      text: null,
      // A device with no recognisable app is usually encrypted end to end (a VPN).
      list: topDevices.map((d) => ({ label: nameOf(d.mac), sub: [mainApp(d) || whatItIs(d), `${pct(d.bytes)}%`].join(" · "), value: fmtGB(d.bytes), mac: d.mac })),
    });
  }
  const topApps = [...byApp.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 5);
  if (topApps.length > 1) {
    out.push({
      id: `top-apps-${start}`,
      kind: "usage",
      level: "info",
      ts: start,
      title: `Top apps ${when}: ${topApps[0].app} ${fmtGB(topApps[0].bytes)}, ${topApps[1].app} ${fmtGB(topApps[1].bytes)}${topApps[2] ? ", …" : ""}`,
      text: "Protocols and unclassified traffic left out.",
      list: topApps.map((a) => {
        const dev = [...a.devices.entries()].sort((x, y) => y[1] - x[1])[0];
        return { label: a.app, sub: dev ? `mostly ${nameOf(dev[0])}` : a.cat, value: fmtGB(a.bytes), app: a.app };
      }),
    });
  }

  // Unusual: a device far above its own normal, from UniFi's daily totals of the 14 days
  // before the period (UU-C-127). Today is compared while still under way, so only a device
  // already past 3x a whole normal day is flagged.
  if (dayKey) {
    const firstDay = dayKey(start - 14 * 24 * HOUR);
    const lastDay = dayKey(start - 1);
    const history = new Map();
    for (const r of db.queryDailyDevice(firstDay, lastDay, null)) {
      const list = history.get(r.mac) || [];
      list.push((r.rx || 0) + (r.tx || 0));
      history.set(r.mac, list);
    }
    const median = (xs) => {
      const v = [...xs].sort((a, b) => a - b);
      return v.length ? v[Math.floor(v.length / 2)] : 0;
    };
    for (const d of byDevice.values()) {
      const h = history.get(d.mac);
      if (!h || h.length < 5) continue; // too little history to know "usual"
      const usual = median(h) * nDays;
      if (usual > 0 && d.bytes > 3 * usual && d.bytes - usual > 2 * GB) {
        out.push({
          id: `unusual-${d.mac}-${start}`,
          kind: "usage",
          level: "warn",
          ts: start,
          title: `${nameOf(d.mac)} used ${(d.bytes / usual).toFixed(1)}× its usual ${when}`,
          text: `${fmtGB(d.bytes)}, against about ${fmtGB(usual)} on a normal ${days ? `${nDays} days` : "day"}${mainApp(d) ? `; mostly ${mainApp(d)}` : ""}.`,
          mac: d.mac,
          hourly: barsFor(d.mac),
          barDays: days ? nDays : null,
        });
      }
    }
  }

  // The day's biggest burst: the largest session of 5-minute rows, any device and app.
  const rows = bundle.buckets
    .filter((b) => b[0] >= start && b[0] < end)
    .map((b) => ({ t: b[0], tEnd: b[0] + (b[7] || 300000), mac: b[1], app: appName(b[2], b[3]), bytes: b[4] + b[5], domain: null }));
  const sessions = sessionize(rows, { gapMs: 10 * 60 * 1000, minBytes: 0, keyBy: "mac+app" }).sort((a, b) => b.bytes - a.bytes);
  const top = sessions[0];
  if (top && top.bytes > 2 * GB) {
    const hourly = barsFor(top.mac);
    const minutes = Math.max(1, Math.round((top.end - top.start) / 60000));
    const share = totalDay ? ` — ${Math.round((top.bytes / totalDay) * 100)}% of ${days ? "all" : "the day's"} traffic` : "";
    // A burst reads as one; a device busy all day (a torrent box) reads as the day's total.
    const burst = minutes <= 180;
    out.push({
      id: `burst-${top.mac}-${top.start}`,
      kind: "usage",
      level: "info",
      ts: top.start,
      // Name the app only when it is one (not "of Unidentified", UU-C-127).
      title: burst
        ? `${nameOf(top.mac)} moved ${fmtGB(top.bytes)} in ${minutes} minutes`
        : plumbing(top.app, "")
          ? `${nameOf(top.mac)} moved ${fmtGB(top.bytes)} in one long stretch ${when}`
          : `${nameOf(top.mac)} used ${fmtGB(top.bytes)} of ${top.app} ${when}`,
      text:
        (burst ? `${clock(top.start)} – ${clock(top.end)}${plumbing(top.app, "") ? "" : `, ${top.app}`}${share}.` : `Busy for ${Math.round(minutes / 60)} hours${share}.`) +
        (top.app === "Unidentified" ? " UniFi can't see what it is — encrypted traffic, for example a WireGuard VPN." : ""),
      mac: top.mac,
      hourly,
      barDays: days ? nDays : null,
      span: burst ? { from: Math.floor(top.start / HOUR) * HOUR, to: Math.floor(top.start / HOUR) * HOUR + HOUR } : null,
    });
  }

  // Weak Wi-Fi: over an hour below −80 dBm.
  for (const c of insights.wifiList(start, end).clients) {
    const poorMin = Math.round(((c.badShare || 0) / 100) * c.minutes);
    if (poorMin < 60) continue;
    out.push({
      id: `wifi-${c.mac}`,
      kind: "wifi",
      level: "warn",
      ts: c.lastSeen,
      title: `${c.name} spent ${poorMin >= 120 ? `${Math.round(poorMin / 60)} hours` : `${poorMin} minutes`} on weak Wi-Fi`,
      text: `Average ${c.avgSignal} dBm on ${c.ap}${c.roams ? `, ${c.roams} roams` : ""}. Pages start to stall below −80 dBm.`,
      mac: c.mac,
    });
  }

  // Slow or renegotiated wired links.
  for (const c of insights.wiredList(start, end).clients) {
    if (c.speed != null && c.speed <= 100) {
      out.push({ id: `link-${c.mac}`, kind: "wired", level: "warn", ts: c.lastSeen, title: `${c.name} links at only ${c.speed} Mbps`, text: `${c.switch || "Switch"}${c.port != null ? ` port ${c.port}` : ""}. Many TVs and small devices top out at 100 Mbps; a cable or port can cause it too.`, mac: c.mac });
    } else if (c.lowSpans?.length && c.topSpeed != null) {
      // Asleep or a bad link? A sleeping PC keeps its link at 10 Mbps (Wake-on-LAN) and moves
      // next to nothing; a real cable or port problem shows up while the device is busy.
      const bytesIn = (a, b) => bundle.buckets.reduce((n, r) => (r[1] === c.mac && r[0] >= a && r[0] < b ? n + r[4] + r[5] : n), 0);
      const spans = c.lowSpans.map((sp) => ({ ...sp, perHour: bytesIn(sp.from, sp.to) / Math.max(1, (sp.to - sp.from) / HOUR) }));
      const busy = spans.filter((sp) => sp.perHour > 5e6);
      if (busy.length) {
        const b = busy[0];
        out.push({ id: `drop-${c.mac}`, kind: "wired", level: "warn", ts: b.from, title: `${c.name} dropped to ${b.speed} Mbps while in use`, text: `It normally runs at ${c.topSpeed} Mbps and was moving data at ${clock(b.from)} at the lower speed (${c.speedChanges} speed change${c.speedChanges === 1 ? "" : "s"}). Check the cable and port.`, mac: c.mac });
      } else {
        const last = spans[spans.length - 1];
        const when = spans.map((sp) => `${clock(sp.from)}${sp.recovered ? `–${clock(sp.to)}` : " on"}`).join(", ");
        out.push({ id: `sleep-${c.mac}`, kind: "wired", level: "info", ts: last.from, title: `${c.name} slept ${when}`, text: `Its link drops to ${Math.min(...spans.map((sp) => sp.speed))} Mbps while it sleeps, which is normal for a PC that can be woken over the network; it runs at ${c.topSpeed} Mbps when awake.`, mac: c.mac });
      }
    }
  }

  // Security: each IPS hit; firewall rules grouped; repeat offenders.
  const t = insights.threats(start, end);
  // One finding per source → target: four attempts from one address are one story, not four.
  const groups = new Map();
  for (const it of t.items.filter((i) => i.kind === "Threat blocked")) {
    const k = `${it.source}|${it.domain || it.target}`;
    const g = groups.get(k);
    if (g) g.n += 1;
    else groups.set(k, { it, n: 1 });
  }
  for (const { it, n } of [...groups.values()].slice(0, 5)) {
    const outsideRepeat = n >= 3 && /^\d+\.\d+\.\d+\.\d+$/.test(it.source || "");
    out.push({
      id: `threat-${it.uid}`,
      kind: "security",
      level: "bad",
      ts: it.ts,
      title: outsideRepeat
        ? `${it.source} tried ${n} times to reach ${it.domain || it.target || "your network"}`
        : `Intrusion attempt${n > 1 ? `s (${n})` : ""} blocked: ${it.source || "a device"} → ${it.domain || it.target || "outside"}`,
      text: it.signature ? `${it.signature}${it.note ? ` — ${it.note}` : ""}` : outsideRepeat ? "The same outside address was blocked repeatedly." : "UniFi blocked it; no connection details were caught for this one.",
      uid: it.uid,
      ip: outsideRepeat ? it.source : undefined,
    });
  }
  const byRule = new Map();
  for (const it of t.items.filter((i) => i.kind === "Firewall block")) {
    const k = it.policy || "a firewall rule";
    const cur = byRule.get(k) || { n: 0, sources: new Set(), ts: it.ts };
    cur.n += 1;
    if (it.source) cur.sources.add(it.source);
    byRule.set(k, cur);
  }
  for (const [rule, v] of byRule) {
    out.push({ id: `rule-${rule}`, kind: "security", level: "info", ts: v.ts, title: `Your “${rule}” rule fired ${v.n === 1 ? "once" : `${v.n} times`}`, text: v.sources.size ? `From ${[...v.sources].slice(0, 3).join(", ")}${v.sources.size > 3 ? " and others" : ""}.` : "", rule });
  }
  // New devices: first seen by this installation today.
  const firstSeen = db.firstSeenSince ? db.firstSeenSince(start) : [];
  for (const d of firstSeen) {
    out.push({ id: `new-${d.mac}`, kind: "device", level: "warn", ts: d.ts, title: `New device on your network: ${nameOf(d.mac)}`, text: `First seen ${days ? new Date(d.ts).toLocaleDateString() + " " : ""}${clock(d.ts)}${d.wired ? " on a wired port" : " on Wi-Fi"}. If you don't recognise it, block it from its page.`, mac: d.mac });
  }

  // Equipment: offline, hot or with an update waiting.
  for (const d of db.latestDeviceSamples()) {
    if (d.state !== 1) out.push({ id: `dev-off-${d.mac}`, kind: "equipment", level: "bad", ts: d.ts, title: `${d.name || d.model} is offline`, text: "UniFi reports it disconnected.", device: d.mac });
    else if (d.temp != null && d.temp >= 80) out.push({ id: `dev-hot-${d.mac}`, kind: "equipment", level: "warn", ts: d.ts, title: `${d.name || d.model} runs hot: ${Math.round(d.temp)} °C`, text: "Check its airflow.", device: d.mac });
    if (d.data?.upgradable) out.push({ id: `dev-fw-${d.mac}`, kind: "equipment", level: "info", ts: d.ts, title: `Firmware update available for ${d.name || d.model}`, text: d.data?.firmware ? `Running ${d.data.firmware}.` : "", device: d.mac });
  }

  // Missing data.
  if (lostSpans.length) {
    const ms = lostSpans.reduce((n, s) => n + (Math.min(s.to, now) - s.from), 0);
    if (ms >= HOUR) out.push({ id: "lost", kind: "data", level: "info", ts: lostSpans[0].from, title: `${Math.round(ms / HOUR)} h of this day were never saved`, text: "UniFi had already deleted that detail before NetLens could read it; those hours show as no data." });
  }

  const order = { bad: 0, warn: 1, info: 2 };
  out.sort((a, b) => order[a.level] - order[b.level] || b.ts - a.ts);
  return out;
}
