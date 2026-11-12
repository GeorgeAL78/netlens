import * as db from "./db.js";
import * as unifi from "./unifi.js";
import { refreshFirewall } from "./firewall.js";

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

// Model names as UniFi shows them, from the Integration API (UU-C-229): stat/device only has
// codes such as "UDMA6A8" for a Cloud Gateway Fiber. Refreshed hourly with the versions.
const modelNames = new Map();

function deviceRow(d, ts) {
  const temps = (d.temperatures || []).map((t) => num(t.value)).filter((v) => v != null);
  const ss = d["system-stats"] || {};
  return {
    ts,
    mac: lower(d.mac),
    name: d.name || d.model || null,
    type: d.type || null,
    model: modelNames.get(lower(d.mac)) || d.model || null,
    state: num(d.state),
    cpu: num(ss.cpu),
    mem: num(ss.mem),
    temp: temps.length ? Math.max(...temps) : num(d.general_temperature),
    uptime: num(d.uptime),
    clients: num(d.num_sta ?? d["user-num_sta"]),
    data: {
      temps: (d.temperatures || []).map((t) => ({ name: t.name, value: num(t.value) })),
      // UniFi's own flag (UU-C-223): switches without a temperature sensor still report it.
      overheating: d.overheating === true,
      radios: (d.radio_table_stats || []).map((r) => ({
        radio: r.radio,
        channel: num(r.channel),
        // The width is in the radio's settings, not its statistics (UU-C-198).
        width: num((d.radio_table || []).find((x) => x.radio === r.radio)?.ht),
        util: num(r.cu_total),
        // Airtime taken by other networks and noise (UU-C-239): busy, but not by this radio.
        interf: num(r.cu_interf),
        txPower: num(r.tx_power),
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
        // Running byte totals (UU-C-233): rx = into the port from the device on it, tx = out to
        // it. They start over when the device restarts.
        rxBytes: num(p.rx_bytes),
        txBytes: num(p.tx_bytes),
        // Packets thrown away and packets carried, running totals like the bytes; flow control
        // as UniFi reports it per direction (UU-C-245).
        txDropped: num(p.tx_dropped),
        rxDropped: num(p.rx_dropped),
        txPackets: num(p.tx_packets),
        rxPackets: num(p.rx_packets),
        fcTx: typeof p.flowctrl_tx === "boolean" ? p.flowctrl_tx : undefined,
        fcRx: typeof p.flowctrl_rx === "boolean" ? p.flowctrl_rx : undefined,
        // The gateway's internet port, and a device's link to the rest of the network (UU-C-239).
        wan: /^wan/i.test(p.network_name || "") || undefined,
        uplink: p.is_uplink === true || undefined,
      })),
      uplink: d.uplink
        ? { speed: num(d.uplink.speed), device: d.uplink.uplink_device_name || null, port: num(d.uplink.uplink_remote_port), localPort: d.uplink.port_idx != null ? num(d.uplink.port_idx) : undefined, wireless: d.uplink.type === "wireless" }
        : null,
      firmware: d.version || null,
      upgradable: Boolean(d.upgradable),
      // UU-C-229: what UniFi shows, and what else it knows about the device.
      version: d.displayable_version || null,
      upgradeTo: d.upgrade_to_firmware || null,
      eol: d.model_in_eol === true,
      modelCode: d.model || null,
      // A gateway's ip is its WAN address; its address on the LAN is lan_ip.
      ip: (/udm|ugw|uxg/.test(d.type || "") ? d.lan_ip || d.connect_request_ip : d.ip) || null,
      satisfaction: num(d.satisfaction) >= 0 ? num(d.satisfaction) : null,
      poeMax: num(d.total_max_power),
      poeUsed: num(d.total_used_power),
      // The gateway's last speed test (UU-C-239), when UniFi has run one.
      speedtest: speedtestOf(d),
    },
  };
}

function speedtestOf(d) {
  const s = d["speedtest-status"];
  if (!s || !(num(s.rundate) > 0)) return undefined;
  return { at: num(s.rundate) * 1000, down: num(s.xput_download), up: num(s.xput_upload), ping: num(s.latency), server: [s.server?.provider, s.server?.city].filter(Boolean).join(", ") || null };
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
      // The public address the ISP gave the gateway (UU-C-172).
      ip: wan.wan_ip || null,
      // The window UniFi's availability covers, in seconds: since the gateway started (UU-C-252).
      period: num(stats.time_period),
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

// UniFi's versions (UU-C-229): the Network application, the one before it, UniFi OS, and which
// statistics engine answers. Read hourly; a change of Network version is remembered with when
// NetLens first saw it, for the Overview and because Network 11 restarted UniFi's own history.
export const versions = { network: null, previousNetwork: null, os: null, stats: null, updateAvailable: false, checkedAt: 0, changed: null, error: null };
try {
  Object.assign(versions, JSON.parse(db.getSetting("unifi_versions", "{}") || "{}"), { error: null });
} catch {}
// From the database, not this module's copy: pages are built on view workers (UU-C-210).
export function storedVersions() {
  try {
    return JSON.parse(db.getSetting("unifi_versions", "{}") || "{}");
  } catch {
    return {};
  }
}
const majorOf = (v) => Number(String(v || "").split(".")[0]) || 0;
export async function refreshVersions({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - versions.checkedAt < 60 * 60 * 1000) return versions;
  try {
    const [info, devs] = await Promise.all([unifi.getSysinfo(), unifi.listIntegrationDevices().catch(() => [])]);
    for (const d of devs) if (d.macAddress && d.model) modelNames.set(lower(d.macAddress), d.model);
    const network = info?.version || null;
    const stats = majorOf(network) >= 11 ? await unifi.getStatsSource().catch(() => null) : "LEGACY";
    const changed = versions.network && network && network !== versions.network ? { from: versions.network, to: network, at: now } : versions.changed;
    Object.assign(versions, {
      network,
      previousNetwork: info?.previous_version || null,
      os: info?.console_display_version || null,
      stats,
      updateAvailable: info?.update_available === true,
      checkedAt: now,
      changed,
      error: null,
    });
    db.setSetting("unifi_versions", JSON.stringify({ ...versions, error: undefined }));
  } catch (err) {
    versions.error = err.message;
  }
  return versions;
}

export async function pollHealth() {
  const ts = Date.now();
  await refreshVersions();
  try {
    const [stations, devices, health] = await Promise.all([unifi.getStations(), unifi.getDevices(), unifi.getHealth()]);
    const clients = stations.map((c) => clientRow(c, ts)).filter((c) => c.mac);
    const devs = devices.map((d) => deviceRow(d, ts)).filter((d) => d.mac);
    siteObjectId = devices.find((d) => d.site_id)?.site_id || siteObjectId;
    // Our own radios, so the nearby list leaves them out (UU-C-239).
    ownBssids = new Set(devices.flatMap((d) => (d.vap_table || []).map((v) => lower(v.bssid))).filter(Boolean));
    apNames = new Map(devices.map((d) => [lower(d.mac), d.name || modelNames.get(lower(d.mac)) || d.model]));
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
// ---- Nearby networks and the internet line's history (UU-C-239) ---------------------------
// Hourly. Nearby: UniFi's neighbouring access points (24 h), our own radios left out, kept as
// setting `nearby_networks` (no BSSIDs: a network is known by name, band and channel). Internet:
// Network 11's statistics engine has each 5 minutes' busiest rate and latency (wan_engine);
// NetLens's own samples only see the rate at the moment of each update.
let ownBssids = new Set();
let apNames = new Map();
export const air = { nearbyAt: 0, wanAt: 0, error: null };
export async function refreshAir({ force = false } = {}) {
  const now = Date.now();
  if (force || now - air.nearbyAt > 3600e3) {
    try {
      const rows = await unifi.getNearbyNetworks(24);
      const keep = rows
        .filter((r) => !ownBssids.has(lower(r.bssid)))
        .map((r) => ({
          essid: r.essid || null,
          band: r.band || r.radio || null,
          channel: num(r.channel),
          width: num(r.bw),
          signal: num(r.signal),
          security: r.security || null,
          heardBy: apNames.get(lower(r.ap_mac)) || null,
          lastSeen: num(r.last_seen) ? num(r.last_seen) * 1000 : null,
        }));
      // UniFi names networks only on the channels the access points use, and remembers them for
      // about 30 days: per channel, what was heard there in that time (UU-C-280), so a channel
      // used before (2.4 GHz 1 until the owner moved to 6) still shows its neighbours. Only a
      // summary per band and channel is kept, never the networks themselves.
      const month = await unifi.getNearbyNetworks(720).catch(() => []);
      const hist = new Map();
      for (const r of month) {
        if (ownBssids.has(lower(r.bssid))) continue;
        const band = r.band || r.radio || null;
        const ch = num(r.channel);
        if (!band || !ch) continue;
        const k = `${band}|${ch}`;
        const h = hist.get(k) || { band, channel: ch, loud: new Set(), radios: 0, loudest: null, lastSeen: 0 };
        h.radios += 1;
        const sig = num(r.signal);
        if (sig != null && sig >= -80) {
          h.loud.add(r.essid || `hidden-${ch}-${lower(r.bssid)}`);
          h.loudest = h.loudest == null ? sig : Math.max(h.loudest, sig);
        }
        h.lastSeen = Math.max(h.lastSeen, num(r.last_seen) ? num(r.last_seen) * 1000 : 0);
        hist.set(k, h);
      }
      const history = [...hist.values()].map((h) => ({ band: h.band, channel: h.channel, radios: h.radios, loud: h.loud.size, loudest: h.loudest, lastSeen: h.lastSeen || null }));
      db.setSetting("nearby_networks", JSON.stringify({ at: now, rows: keep, history }));
      // The networks (VLANs) by subnet, to name the network a device was on (UU-C-248).
      const nets = await unifi.getNetworks().catch(() => null);
      if (nets) db.setSetting("networks", JSON.stringify(nets.filter((n) => n.ip_subnet && n.purpose !== "wan").map((n) => ({ name: n.name, vlan: num(n.vlan) || 1, subnet: n.ip_subnet }))));
      // The firewall rules and zones (UU-C-270), for Protection › Firewall rules.
      await refreshFirewall().catch(() => null);
      // The access points' last RF scans; a scan already kept is skipped (same time).
      const scans = await unifi.getRfScans().catch(() => []);
      db.saveRfScan(
        scans.flatMap((d) => {
          const ts = num(d.spectrum_scan_timestamp);
          if (!ts || d.spectrum_scanning) return [];
          const at = ts > 1e12 ? ts : ts * 1000;
          return (d.scans || []).flatMap((s) =>
            (s.spectrum_table || []).filter((x) => num(x.channel)).map((x) => ({ ts: at, mac: lower(d.mac), radio: s.radio, channel: num(x.channel), width: num(x.width), util: num(x.utilization), interf: num(x.interference) }))
          );
        })
      );
      air.nearbyAt = now;
      air.error = null;
    } catch (err) {
      air.error = err.message;
    }
  }
  if (versions.stats === "MODERN" && (force || now - air.wanAt > 3600e3)) {
    try {
      const rows = await unifi.getStatsSeries("wanBySite", "DAY", now);
      const mine = siteObjectId && rows.some((r) => r.siteId === siteObjectId) ? rows.filter((r) => r.siteId === siteObjectId) : rows.slice(0, 1);
      // Whole 5-minute buckets only; the current one is still filling.
      const points = mine.flatMap((r) => r.series || []).filter((p) => num(p.timestamp) && num(p.duration) >= 290e3);
      db.saveWanEngine(
        points.map((p) => ({
          ts: num(p.timestamp),
          duration: num(p.duration),
          rxMax: num(p.maxRxRateBps),
          txMax: num(p.maxTxRateBps),
          rxBytes: num(p.rxBytes),
          txBytes: num(p.txBytes),
          latency: num(p.avgLatencyMs),
          latencyMax: num(p.maxLatencyMs),
          availability: num(p.avgAvailabilityPct),
        }))
      );
      air.wanAt = now;
    } catch (err) {
      air.error = err.message;
    }
    // Per access point over the last day (newer firmware on Network 11): how often frames had to
    // be sent again, client satisfaction and signal. Setting `wifi_engine`; older versions have
    // none and the Wi-Fi page leaves the columns out.
    try {
      const rows = await unifi.getStatsSeries("wirelessBySiteByDevice", "DAY", now);
      const out = {};
      for (const r of rows) {
        if (siteObjectId && r.siteId && r.siteId !== siteObjectId) continue;
        const s = r.series || [];
        const sum = (k) => s.reduce((n, p) => n + (num(p[k]) || 0), 0);
        const mean = (k) => {
          const v = s.map((p) => num(p[k])).filter((x) => x != null);
          return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
        };
        const attempts = sum("wifiTxAttemptPackets");
        out[lower(r.deviceMac)] = { retryPct: attempts > 0 ? Math.round((sum("wifiTxRetryPackets") / attempts) * 1000) / 10 : null, satisfaction: mean("avgClientSatisfactionScore"), signal: mean("avgClientSignalDbm"), interf: mean("avgInterfCuPct") };
      }
      db.setSetting("wifi_engine", JSON.stringify({ at: now, aps: out }));
    } catch (err) {
      air.error = err.message;
    }
  }
}

export const daily = { lastFetchedAt: 0, rows: 0, error: null };

// Network 11 (UU-C-231): per-device internet traffic from the statistics engine's
// wanTrafficBySiteByClient, hourly buckets summed into local days. Measured against UniFi's DPI
// over the same three hours: 302.0 / 33.7 MB down / up against 323.9 / 37.3 MB, the busiest
// device within 10%, the next ones equal. rx is download, as in stat/report. The first run of a
// process reads every week back to DAILY_REACH_MS or until a week is empty (the engine starts at
// the upgrade); after that only the last 7 days, and the oldest of them, cut by the window, is
// not saved. A day's total never shrinks (saveDailyDeviceMax).
const WEEK_MS = 7 * 24 * 3600e3;
let engineBackfillAt = 0;
let siteObjectId = null; // the site's _id, which the engine's rows carry (stat/device site_id)
async function refreshDailyModern(dayKeyOf, now) {
  try {
    const full = now - engineBackfillAt > 24 * 3600e3;
    const pages = full ? Math.ceil(DAILY_REACH_MS / WEEK_MS) : 1;
    const seen = new Set();
    const sums = new Map();
    let end = now;
    for (let i = 0; i < pages; i += 1) {
      const rows = await unifi.getStatsSeries("wanTrafficBySiteByClient", "WEEK", end);
      const mine = siteObjectId && rows.some((c) => c.siteId === siteObjectId) ? rows.filter((c) => c.siteId === siteObjectId) : rows;
      let points = 0;
      for (const c of mine) {
        // clientId is the MAC today; a later version could switch it to an id like the rules'
        // (UU-C-237), so only a MAC-shaped value is used and anything else is skipped.
        const mac = [c.clientId, c.clientMac, c.mac].map(lower).find((v) => /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(v || ""));
        if (!mac) continue;
        for (const p of c.series || []) {
          const k = `${mac}|${p.timestamp}`;
          if (seen.has(k) || !(p.timestamp >= end - WEEK_MS) || p.timestamp >= end) continue;
          seen.add(k);
          points += 1;
          const day = dayKeyOf(Number(p.timestamp));
          const s = sums.get(`${day}|${mac}`) || { day, mac, rx: 0, tx: 0 };
          s.rx += (num(p.rxApplicationBytes) || 0) + (num(p.rxOtherBytes) || 0);
          s.tx += (num(p.txApplicationBytes) || 0) + (num(p.txOtherBytes) || 0);
          sums.set(`${day}|${mac}`, s);
        }
      }
      if (!points) break;
      end -= WEEK_MS;
    }
    // Only reading the last week: its first day is cut by the window, keep what is stored.
    const cut = full ? null : dayKeyOf(now - WEEK_MS);
    const out = [...sums.values()].filter((s) => s.day !== cut).map((s) => ({ ...s, rx: Math.round(s.rx), tx: Math.round(s.tx) }));
    db.saveDailyDeviceMax(out);
    db.pruneDailyDevice(dayKeyOf(now - DAILY_KEEP_DAYS * 86400e3));
    if (full) engineBackfillAt = now;
    Object.assign(daily, { lastFetchedAt: now, rows: out.length, error: null, source: "statistics engine" });
    return { rows: out.length, source: "engine" };
  } catch (err) {
    daily.error = err.message;
    throw err;
  }
}

export async function refreshDaily(dayKeyOf, { force = false } = {}) {
  const now = Date.now();
  if (!force && now - daily.lastFetchedAt < 60 * 60 * 1000) return { skipped: true };
  // Network 11 retired stat/report: it answers ok with no rows, for good (UU-C-229). Its new
  // statistics engine has the same numbers (UU-C-231). Network 10 and older keep the old path.
  if (versions.stats === "MODERN") return refreshDailyModern(dayKeyOf, now);
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
