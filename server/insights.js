import * as db from "./db.js";

// Views over the live samples and the System Log (UU-C-056): gateway/WAN strip, equipment
// health, Wi-Fi quality per client, threats. Everything reads SQLite only — like
// /api/report, no request here ever waits on UniFi.
//
// Dwell time, favourite AP and the presence pattern use the definitions of unifi-toolkit's
// Wi-Fi Stalker (Crosstalk Solutions, MIT): minutes per AP (Wi-Fi only); the AP with the
// most minutes over 30 days, most recent winning a tie; a 24x7 grid of average minutes
// connected per hour-of-day x day-of-week, meaningful after 7 days. Ours is computed from
// 5-minute samples rather than connect/disconnect sessions, so roams within one session
// count toward the right AP.

const SAMPLE_MIN = 5;
const WEAK = -75;
const BAD = -80;
const BANDS = { ng: "2.4 GHz", na: "5 GHz", "6e": "6 GHz" };
export const bandName = (r) => BANDS[r] || r || null;

function stepFor(start, end) {
  const span = end - start;
  if (span <= 36 * 3600e3) return SAMPLE_MIN * 60e3;
  if (span <= 8 * 86400e3) return 3600e3;
  return 4 * 3600e3;
}

function bucketsOf(rows, start, end, pick) {
  const step = stepFor(start, end);
  const map = new Map();
  for (const r of rows) {
    const t = start + Math.floor((r.ts - start) / step) * step;
    const list = map.get(t);
    if (list) list.push(r);
    else map.set(t, [r]);
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([t, list]) => ({ t, ...pick(list) }));
}

const avg = (xs) => {
  const v = xs.filter((x) => x != null);
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
};
const minOf = (xs) => {
  const v = xs.filter((x) => x != null);
  return v.length ? Math.min(...v) : null;
};

export function names() {
  const byMac = new Map();
  for (const c of db.listStoredClients()) if (c.mac) byMac.set(String(c.mac).toLowerCase(), c.name || c.hostname || c.mac);
  for (const [m, n] of db.siemNamesByMac()) if (!byMac.has(m)) byMac.set(m, n);
  for (const d of db.latestDeviceSamples()) if (d.mac && d.name) byMac.set(d.mac, d.name);
  return (mac) => byMac.get(String(mac || "").toLowerCase()) || mac || null;
}

// ---- gateway / WAN strip --------------------------------------------------------------

export function gatewayStatus() {
  const wan = db.latestWanSample();
  const gw = db.latestDeviceSamples().find((d) => ["udm", "ugw", "uxg"].includes(d.type)) || null;
  const now = Date.now();
  const day = db.queryWanSamples(now - 24 * 3600e3, now + 1);
  return {
    sampledAt: wan?.ts || null,
    status: wan?.status || null,
    isp: wan?.isp || null,
    latency: wan?.latency ?? null,
    availability: wan?.availability ?? null,
    monitors: wan?.data?.monitors || [],
    clients: wan?.data?.clients || null,
    gateway: gw ? { name: gw.name, cpu: gw.cpu, mem: gw.mem, temp: gw.temp, uptime: gw.uptime } : null,
    day: {
      latencyAvg: avg(day.map((r) => r.latency)),
      latencyMax: day.length ? Math.max(...day.map((r) => r.latency ?? 0)) : null,
      availabilityMin: minOf(day.map((r) => r.availability)),
      samples: day.length,
    },
  };
}

// ---- equipment health -----------------------------------------------------------------

export function equipment(start, end) {
  const rows = db.queryDeviceSamples(start, end);
  const byMac = new Map();
  for (const r of rows) {
    const list = byMac.get(r.mac);
    if (list) list.push(r);
    else byMac.set(r.mac, [r]);
  }
  const latest = new Map(db.latestDeviceSamples().map((d) => [d.mac, d]));
  const devices = [...new Set([...latest.keys(), ...byMac.keys()])].map((mac) => {
    const list = byMac.get(mac) || [];
    const last = latest.get(mac) || list[list.length - 1];
    const radios = [...new Set(list.flatMap((r) => (r.data.radios || []).map((x) => x.radio)))];
    return {
      mac,
      name: last?.name,
      type: last?.type,
      model: last?.model,
      online: last?.state === 1,
      firmware: last?.data?.firmware || null,
      upgradable: Boolean(last?.data?.upgradable),
      latest: last
        ? {
            ts: last.ts,
            cpu: last.cpu,
            mem: last.mem,
            temp: last.temp,
            temps: last.data.temps || [],
            uptime: last.uptime,
            clients: last.clients,
            radios: (last.data.radios || []).map((r) => ({ ...r, band: bandName(r.radio) })),
            ports: last.data.ports || [],
            uplink: last.data.uplink || null,
          }
        : null,
      peak: {
        cpu: list.length ? Math.max(...list.map((r) => r.cpu ?? 0)) : null,
        mem: list.length ? Math.max(...list.map((r) => r.mem ?? 0)) : null,
        temp: list.some((r) => r.temp != null) ? Math.max(...list.map((r) => r.temp ?? -Infinity)) : null,
      },
      series: bucketsOf(list, start, end, (g) => {
        const out = { cpu: avg(g.map((r) => r.cpu)), mem: avg(g.map((r) => r.mem)), temp: avg(g.map((r) => r.temp)), clients: avg(g.map((r) => r.clients)) };
        for (const radio of radios) out[`util_${radio}`] = avg(g.map((r) => (r.data.radios || []).find((x) => x.radio === radio)?.util));
        return out;
      }),
      radios: radios.map((r) => ({ radio: r, band: bandName(r) })),
    };
  });
  const order = { udm: 0, ugw: 0, uxg: 0, usw: 1, uap: 2 };
  devices.sort((a, b) => (order[a.type] ?? 3) - (order[b.type] ?? 3) || String(a.name).localeCompare(String(b.name)));
  return { devices, step: stepFor(start, end), samples: rows.length };
}

// ---- Wi-Fi quality --------------------------------------------------------------------

function roamsFor(start, end, mac) {
  return db
    .querySiemEvents(start, end, mac || null)
    .filter((e) => e.kind === "log" && /ROAMED/.test(e.data?.key || ""))
    .map((e) => ({ ts: e.ts, mac: e.mac, msg: e.data?.msg || null, via: e.data?.via || null }));
}

export function wifiList(start, end) {
  const nameOf = names();
  const rows = db.queryClientSamples(start, end, null).filter((r) => !r.wired);
  const roams = roamsFor(start, end, null);
  const roamCount = new Map();
  for (const r of roams) roamCount.set(r.mac, (roamCount.get(r.mac) || 0) + 1);
  const byMac = new Map();
  for (const r of rows) {
    const list = byMac.get(r.mac);
    if (list) list.push(r);
    else byMac.set(r.mac, [r]);
  }
  const clients = [...byMac.entries()].map(([mac, list]) => {
    const last = list[list.length - 1];
    const sig = list.map((r) => r.signal).filter((s) => s != null);
    return {
      mac,
      name: nameOf(mac),
      ap: nameOf(last.ap_mac),
      band: bandName(last.radio),
      channel: last.channel,
      signal: last.signal,
      lastSeen: last.ts,
      avgSignal: avg(sig),
      weakShare: sig.length ? Math.round((sig.filter((s) => s < WEAK).length / sig.length) * 100) : null,
      badShare: sig.length ? Math.round((sig.filter((s) => s < BAD).length / sig.length) * 100) : null,
      satisfaction: avg(list.map((r) => r.satisfaction)),
      roams: roamCount.get(mac) || 0,
      minutes: list.length * SAMPLE_MIN,
    };
  });
  clients.sort((a, b) => (b.badShare ?? -1) - (a.badShare ?? -1) || (a.avgSignal ?? 0) - (b.avgSignal ?? 0));
  return { clients, thresholds: { weak: WEAK, bad: BAD } };
}

// Wired devices (UU-C-078): the same 5-minute samples, wired = 1. Which switch and port,
// link speed now and the slowest seen (a cable or port renegotiating down shows up here),
// how often the speed changed, and how long the device was connected.
export function wiredList(start, end) {
  const nameOf = names();
  const byMac = new Map();
  for (const r of db.queryClientSamples(start, end, null)) {
    if (!r.wired) continue;
    const list = byMac.get(r.mac);
    if (list) list.push(r);
    else byMac.set(r.mac, [r]);
  }
  const mbps = (r) => (r.tx_rate != null ? Math.round(r.tx_rate / 1000) : null);
  const clients = [...byMac.entries()].map(([mac, list]) => {
    const last = list[list.length - 1];
    const speeds = list.map(mbps).filter((v) => v != null);
    let changes = 0;
    for (let i = 1; i < list.length; i += 1) if (mbps(list[i]) != null && mbps(list[i - 1]) != null && mbps(list[i]) !== mbps(list[i - 1])) changes += 1;
    return {
      mac,
      name: nameOf(mac),
      switch: last.ap_mac ? nameOf(last.ap_mac) : null,
      port: last.port ?? null,
      speed: mbps(last),
      minSpeed: speeds.length ? Math.min(...speeds) : null,
      speedChanges: changes,
      lastSeen: last.ts,
      minutes: list.length * SAMPLE_MIN,
      // UniFi's own connection time at the last sample, not how long NetLens has watched.
      uptime: last.uptime ?? null,
    };
  });
  // Slow links first (a gigabit device stuck at 100 Mbps is the thing worth seeing), then by name.
  clients.sort((a, b) => (a.minSpeed ?? 1e9) - (b.minSpeed ?? 1e9) || String(a.name).localeCompare(String(b.name)));
  return { clients };
}

export function wifiClient(start, end, mac, tz) {
  const nameOf = names();
  const m = String(mac).toLowerCase();
  const rows = db.queryClientSamples(start, end, m);
  const wifi = rows.filter((r) => !r.wired);
  const last = rows[rows.length - 1] || null;
  const sig = wifi.map((r) => r.signal).filter((s) => s != null);

  const perAp = new Map();
  for (const r of wifi) {
    const key = `${r.ap_mac}|${r.radio}`;
    const cur = perAp.get(key) || { ap: nameOf(r.ap_mac), band: bandName(r.radio), minutes: 0, signals: [], lastSeen: 0 };
    cur.minutes += SAMPLE_MIN;
    if (r.signal != null) cur.signals.push(r.signal);
    cur.lastSeen = Math.max(cur.lastSeen, r.ts);
    perAp.set(key, cur);
  }
  const dwell = [...perAp.values()]
    .map((d) => ({ ap: d.ap, band: d.band, minutes: d.minutes, avgSignal: avg(d.signals), lastSeen: d.lastSeen }))
    .sort((a, b) => b.minutes - a.minutes || b.lastSeen - a.lastSeen);

  // Favourite AP: always over the last 30 days, per the Stalker definition.
  const now = Date.now();
  const month = db.queryClientSamples(now - 30 * 86400e3, now + 1, m).filter((r) => !r.wired);
  const favMap = new Map();
  for (const r of month) {
    const cur = favMap.get(r.ap_mac) || { minutes: 0, lastSeen: 0 };
    cur.minutes += SAMPLE_MIN;
    cur.lastSeen = Math.max(cur.lastSeen, r.ts);
    favMap.set(r.ap_mac, cur);
  }
  const fav = [...favMap.entries()].sort((a, b) => b[1].minutes - a[1].minutes || b[1].lastSeen - a[1].lastSeen)[0];

  // Presence: average minutes connected per hour-of-day x weekday, over every sample we
  // have for this client (up to 90 days), divided by how often that slot occurred while
  // the collector was running.
  const all = db.queryClientSamples(now - 90 * 86400e3, now + 1, m);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric" });
  const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const slotOf = (ts) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
    return { dow: DOW[p.weekday], hour: Number(p.hour) % 24, day: `${p.year}-${p.month}-${p.day}` };
  };
  const minutes = Array.from({ length: 24 }, () => Array(7).fill(0));
  for (const r of all) {
    const s = slotOf(r.ts);
    minutes[s.hour][s.dow] += SAMPLE_MIN;
  }
  // How many times each slot was observed at all (any client sample in that hour).
  const firstTs = db.firstClientSampleTs() || now;
  const seen = Array.from({ length: 24 }, () => Array(7).fill(0));
  for (let t = Math.floor(firstTs / 3600e3) * 3600e3; t < now; t += 3600e3) {
    const s = slotOf(t);
    seen[s.hour][s.dow] += 1;
  }
  const presence = minutes.map((row, h) => row.map((v, d) => (seen[h][d] ? Math.round(v / seen[h][d]) : 0)));
  const daysOfData = Math.floor((now - firstTs) / 86400e3);

  return {
    mac: m,
    name: nameOf(m),
    wired: last ? Boolean(last.wired) : null,
    current: last
      ? {
          ts: last.ts,
          ap: nameOf(last.ap_mac),
          band: bandName(last.radio),
          channel: last.channel,
          width: last.width,
          essid: last.essid,
          signal: last.signal,
          noise: last.noise,
          txRate: last.tx_rate,
          rxRate: last.rx_rate,
          satisfaction: last.satisfaction,
        }
      : null,
    summary: {
      avgSignal: avg(sig),
      minSignal: minOf(sig),
      weakMinutes: sig.filter((s) => s < WEAK).length * SAMPLE_MIN,
      badMinutes: sig.filter((s) => s < BAD).length * SAMPLE_MIN,
      minutes: wifi.length * SAMPLE_MIN,
      satisfaction: avg(wifi.map((r) => r.satisfaction)),
    },
    thresholds: { weak: WEAK, bad: BAD },
    series: bucketsOf(wifi, start, end, (g) => ({
      signal: avg(g.map((r) => r.signal)),
      minSignal: minOf(g.map((r) => r.signal)),
      satisfaction: avg(g.map((r) => r.satisfaction)),
      band: bandName(g[g.length - 1].radio),
      ap: nameOf(g[g.length - 1].ap_mac),
    })),
    dwell,
    favoriteAp: fav ? { ap: nameOf(fav[0]), hours: Math.round((fav[1].minutes / 60) * 10) / 10 } : null,
    roams: roamsFor(start, end, m).slice(0, 100),
    presence: { minutes: presence, daysOfData, sufficient: daysOfData >= 7 },
    // When this installation took its first sample: signal figures only cover time after it,
    // while roams come from UniFi's event log and cover the whole period (UU-C-084).
    sampledSince: firstTs,
  };
}

// ---- threats ----------------------------------------------------------------------------

export function threats(start, end) {
  const rows = db.querySiemEvents(start, end, null).filter((e) => e.kind === "log" && /security/i.test(e.category || ""));
  // Signatures read from the matching flow records (UU-C-071); none for firewall blocks.
  const sigs = db.ipsDetails(start, end);
  const items = rows.map((e) => {
    const p = e.data?.params || {};
    const firewall = /TRAFFIC_BLOCKED/.test(e.data?.key || "");
    const ips = sigs.get(e.uid) || null;
    return {
      uid: e.uid,
      ts: e.ts,
      kind: firewall ? "Firewall block" : "Threat blocked",
      severity: e.data?.severity || null,
      // The blocked connection's full record (UU-C-077), for the detail panel.
      detail: ips,
      title: e.name,
      source: p.SRC_CLIENT?.n || p.SRC_IP?.n || null,
      target: p.DST_CLIENT?.n || p.DST_IP?.n || null,
      policy: p.TRIGGER?.n || ips?.policy || null,
      signature: ips?.signature || null,
      signatureId: ips?.signatureId || null,
      ipsCategory: ips?.category || null,
      domain: ips?.domain || null,
      risk: ips?.risk || null,
      note: ips?.note || null,
      msg: e.data?.msg || null,
    };
  });
  const top = (key) => {
    const m = new Map();
    for (const it of items) if (it[key]) m.set(it[key], (m.get(it[key]) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ name, count }));
  };
  return {
    total: items.length,
    threats: items.filter((i) => i.kind === "Threat blocked").length,
    firewall: items.filter((i) => i.kind === "Firewall block").length,
    topSources: top("source"),
    topTargets: top("target"),
    topPolicies: top("policy"),
    topSignatures: top("signature"),
    // Threat events still waiting for (or past the reach of) a signature lookup.
    threatsWithoutSignature: items.filter((i) => i.kind === "Threat blocked" && !i.signature).length,
    items: items.slice(0, 300),
  };
}
