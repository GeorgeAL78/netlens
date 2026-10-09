import * as db from "./db.js";
import * as unifi from "./unifi.js";

// Live samples every 5 minutes (UU-C-056): Wi-Fi quality per client, equipment health and
// the WAN. UniFi only reports these as "right now", so history exists only because this
// container samples them around the clock. Kept 90 days, like events.
//
// Three calls per snapshot: stat/sta (clients), stat/device (APs, switches, gateway) and
// stat/health (WAN). Fields measured on Network 10.6.106 — e.g. a client's band ("6e"),
// channel/width, signal and noise in dBm, link rates in kbps, satisfaction, retries; a
// device's system-stats cpu/mem, temperatures, radio_table_stats channel use; the WAN's
// ISP, latency and monitor availability.
export const RETAIN_MS = 90 * 24 * 60 * 60 * 1000;

const num = (v) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const lower = (v) => (v ? String(v).toLowerCase() : null);

function clientRow(c, ts) {
  const wired = Boolean(c.is_wired);
  return {
    ts,
    mac: lower(c.mac),
    wired,
    apMac: wired ? lower(c.sw_mac) : lower(c.ap_mac),
    radio: wired ? null : c.radio || null,
    channel: num(c.channel),
    width: num(c.channel_width),
    essid: c.essid || null,
    signal: wired ? null : num(c.signal),
    noise: wired ? null : num(c.noise),
    txRate: num(wired ? c.wired_rate_mbps * 1000 : c.tx_rate),
    rxRate: num(c.rx_rate),
    satisfaction: num(c.satisfaction) >= 0 ? num(c.satisfaction) : null,
    txRetries: num(c.tx_retries),
    txAttempts: num(c.wifi_tx_attempts),
    port: wired ? num(c.sw_port) : null,
    // How long UniFi says the client has been connected, in seconds (UU-C-086).
    uptime: num(c.uptime),
    ip: c.ip || c.last_ip || null,
  };
}

function deviceRow(d, ts) {
  const temps = (d.temperatures || []).map((t) => num(t.value)).filter((v) => v != null);
  const ss = d["system-stats"] || {};
  return {
    ts,
    mac: lower(d.mac),
    name: d.name || d.model || null,
    type: d.type || null,
    model: d.model || null,
    state: num(d.state),
    cpu: num(ss.cpu),
    mem: num(ss.mem),
    temp: temps.length ? Math.max(...temps) : num(d.general_temperature),
    uptime: num(d.uptime),
    clients: num(d.num_sta ?? d["user-num_sta"]),
    data: {
      temps: (d.temperatures || []).map((t) => ({ name: t.name, value: num(t.value) })),
      radios: (d.radio_table_stats || []).map((r) => ({
        radio: r.radio,
        channel: num(r.channel),
        util: num(r.cu_total),
        clients: num(r.num_sta),
      })),
      ports: (d.port_table || []).map((p) => ({
        idx: num(p.port_idx),
        name: p.name,
        up: Boolean(p.up),
        speed: num(p.speed),
        poe: num(p.poe_power),
        rxErrors: num(p.rx_errors),
        txErrors: num(p.tx_errors),
      })),
      uplink: d.uplink
        ? { speed: num(d.uplink.speed), device: d.uplink.uplink_device_name || null, port: num(d.uplink.uplink_remote_port) }
        : null,
      firmware: d.version || null,
      upgradable: Boolean(d.upgradable),
    },
  };
}

function wanRow(health, ts) {
  const wan = health.find((h) => h.subsystem === "wan") || {};
  const www = health.find((h) => h.subsystem === "www") || {};
  const stats = wan.uptime_stats?.WAN || {};
  return {
    ts,
    status: wan.status || www.status || null,
    isp: wan.isp_name || wan.isp_organization || null,
    latency: num(stats.latency_average ?? www.latency),
    availability: num(stats.availability),
    drops: num(www.drops),
    rxRate: num(wan["rx_bytes-r"]),
    txRate: num(wan["tx_bytes-r"]),
    data: {
      monitors: (stats.monitors || stats.alerting_monitors || []).map((m) => ({
        target: m.target,
        type: m.type,
        latency: num(m.latency_average),
        availability: num(m.availability),
      })),
      gateway: wan["gw_system-stats"] || null,
      clients: { wifi: num(health.find((h) => h.subsystem === "wlan")?.num_user), wired: num(health.find((h) => h.subsystem === "lan")?.num_user) },
    },
  };
}

let lastPrune = 0;
export const state = { lastPolledAt: null, error: null, counts: null };

export async function pollHealth() {
  const ts = Date.now();
  try {
    const [stations, devices, health] = await Promise.all([unifi.getStations(), unifi.getDevices(), unifi.getHealth()]);
    const clients = stations.map((c) => clientRow(c, ts)).filter((c) => c.mac);
    const devs = devices.map((d) => deviceRow(d, ts)).filter((d) => d.mac);
    db.saveLiveSamples({ clients, devices: devs, wan: wanRow(health, ts) });
    db.saveLocalNames("device", deviceNames(devices), ts);
    if (ts - lastPrune > 60 * 60 * 1000) {
      db.pruneLiveSamples(ts - RETAIN_MS);
      lastPrune = ts;
    }
    state.lastPolledAt = ts;
    state.error = null;
    state.counts = { clients: clients.length, devices: devs.length };
    return state.counts;
  } catch (err) {
    state.error = err.message;
    throw err;
  }
}

// ---- Names for local destinations (UU-F-052) ------------------------------------------
//
// Flows to the LAN name their destination only by MAC or IP when UniFi has no hostname.
// The gateway was the biggest such destination (2.9 GB over 7 days, to one of its LAN
// interface MACs): stat/device lists a device's MAC per interface, port and network, and
// its address on each network (ip_subnet "192.168.1.1/24"). Known clients (rest/user)
// cover devices that are offline now.
function deviceNames(devices) {
  const out = [];
  for (const d of devices || []) {
    const name = d.name || d.model;
    if (!name) continue;
    const macs = [d.mac, ...(d.ethernet_table || []).map((e) => e.mac), ...(d.port_table || []).map((p) => p.mac), ...(d.network_table || []).map((n) => n.mac)];
    const ips = [d.ip, d.lan_ip, ...(d.network_table || []).map((n) => String(n.ip_subnet || "").split("/")[0])];
    for (const k of [...macs.map(lower), ...ips]) if (k) out.push([k, name]);
  }
  return out;
}

function knownClientNames(users) {
  const out = [];
  const byLastIp = new Map();
  for (const u of users || []) {
    const name = u.name || u.hostname;
    if (!name || !u.mac) continue;
    out.push([lower(u.mac), name]);
    if (u.use_fixedip && u.fixed_ip) out.push([u.fixed_ip, name]);
    if (u.last_ip) byLastIp.set(u.last_ip, byLastIp.has(u.last_ip) ? null : name);
  }
  // A last-seen address can have been handed to another client since; only when one known
  // client claims it.
  for (const [ip, name] of byLastIp) if (name) out.push([ip, name]);
  return out;
}

// ---- Connection detail for security events (UU-C-071, UU-C-077) ------------------------
//
// Each "Threat blocked" and firewall-block System Log event is matched to its flow record
// (same source, same target address, within minutes) while the console still keeps flows
// (~4 days), and the record's detail — signature, policy, both ends, traffic — is stored next
// to the event. At most 40 lookups per run, each one narrow (four minutes, one device when
// known), so the console barely notices.
const IPS_REACH_MS = 4 * 24 * 60 * 60 * 1000;
export const ips = { lastRunAt: 0, found: 0, missed: 0, error: null };

export async function refreshIpsDetails() {
  const now = Date.now();
  try {
    let found = 0;
    let missed = 0;
    const isMac = (v) => /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(String(v || "").toLowerCase());
    const isIp = (v) => /^\d{1,3}(\.\d{1,3}){3}$/.test(String(v || ""));
    for (const ev of db.pendingIpsLookups(now - IPS_REACH_MS, 40, now, unifi.SECURITY_DETAIL_VERSION)) {
      const p = ev.data?.params || {};
      const mac = isMac(p.SRC_CLIENT?.i) ? lower(p.SRC_CLIENT.i) : null;
      const srcIp = !mac && isIp(p.SRC_IP?.i) ? p.SRC_IP.i : null;
      const dstIp = [p.DST_IP?.i, p.DST_IP?.n].find(isIp) || null;
      // IPS threats match the flow carrying the signature; firewall blocks any blocked flow.
      const detail = await unifi.findBlockedFlow({ ts: ev.ts, mac, srcIp, dstIp, ips: /^THREAT_/.test(ev.data?.key || "") });
      db.saveIpsDetail(ev.uid, ev.ts, detail, now);
      if (detail) found += 1;
      else missed += 1;
    }
    Object.assign(ips, { lastRunAt: now, found: ips.found + found, missed: ips.missed + missed, error: null });
    return { found, missed };
  } catch (err) {
    ips.error = err.message;
    throw err;
  }
}

export const names = { lastFetchedAt: 0, error: null };

export async function refreshLocalNames({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - names.lastFetchedAt < 60 * 60 * 1000) return { skipped: true };
  try {
    const pairs = knownClientNames(await unifi.getKnownClients());
    db.saveLocalNames("client", pairs, now);
    Object.assign(names, { lastFetchedAt: now, error: null });
    return { names: pairs.length };
  } catch (err) {
    names.error = err.message;
    throw err;
  }
}

// ---- UniFi daily per-device totals (UU-C-057) -----------------------------------------
//
// One call returns ~90 days x every device (about 4,000 rows). Re-read hourly: the newest
// day keeps growing until midnight. Kept a year, so this history outgrows UniFi's own 90 days.
const DAILY_REACH_MS = 92 * 24 * 60 * 60 * 1000;
const DAILY_KEEP_DAYS = 366;
export const daily = { lastFetchedAt: 0, rows: 0, error: null };

export async function refreshDaily(dayKeyOf, { force = false } = {}) {
  const now = Date.now();
  if (!force && now - daily.lastFetchedAt < 60 * 60 * 1000) return { skipped: true };
  try {
    const rows = await unifi.getDailyUser(now - DAILY_REACH_MS, now);
    const out = rows
      .filter((r) => r.user && r.time)
      .map((r) => ({ day: dayKeyOf(Number(r.time)), mac: lower(r.user), rx: num(r.rx_bytes) || 0, tx: num(r.tx_bytes) || 0 }));
    db.saveDailyDevice(out);
    db.pruneDailyDevice(dayKeyOf(now - DAILY_KEEP_DAYS * 86400e3));
    Object.assign(daily, { lastFetchedAt: now, rows: out.length, error: null });
    return { rows: out.length };
  } catch (err) {
    daily.error = err.message;
    throw err;
  }
}
