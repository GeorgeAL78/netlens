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
