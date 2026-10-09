import { Agent, fetch } from "undici";
import * as db from "./db.js";
import { logError } from "./log.js";

const agent = new Agent({ connect: { rejectUnauthorized: false } });

// Measured on a live UCG Fiber: a single busy 3-hour slice reports
// total_element_count=10000 over 10 pages (or_more=true). 6 pages was losing >=40%.
const FLOW_MAX_PAGES = 40;

function config() {
  return {
    host: db.getSetting("unifi_host", "192.168.1.1"),
    apiKey: db.getSetting("unifi_api_key", process.env.UNIFI_API_KEY),
    siteId: db.getSetting("unifi_site_id", process.env.UNIFI_SITE_ID),
    site: db.getSetting("unifi_site", "default"),
  };
}

async function request(path, { method = "GET", body } = {}) {
  const { host, apiKey } = config();
  const url = path.startsWith("http") ? path : `https://${host}${path}`;
  const res = await fetch(url, {
    method,
    dispatcher: agent,
    headers: {
      "X-API-KEY": apiKey,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text.slice(0, 400) };
    }
  }
  if (!res.ok) {
    const err = new Error(`UniFi ${res.status} ${method} ${path}`);
    err.status = res.status;
    err.body = json;
    logError("unifi", err, { status: res.status, method, path });
    throw err;
  }
  return json;
}

async function paginate(path, { limit = 200 } = {}) {
  const items = [];
  let offset = 0;
  let total = Infinity;
  while (offset < total) {
    const sep = path.includes("?") ? "&" : "?";
    const page = await request(`${path}${sep}offset=${offset}&limit=${limit}`);
    const data = page?.data ?? [];
    total = page?.totalCount ?? data.length;
    items.push(...data);
    if (!data.length) break;
    offset += data.length;
  }
  return items;
}

export function isBlocked(access) {
  if (!access || typeof access !== "object") return false;
  if (access.blocked === true) return true;
  const type = String(access.type || "").toUpperCase();
  return type.includes("BLOCK");
}

// The Integration API addresses a site by UUID. A fresh container (or a new key) does not
// know it, so it is looked up once from the site list — matching the Network site name,
// "default" unless set — and saved. UU-C-054.
async function resolveSiteId() {
  const { siteId, site } = config();
  if (siteId) return siteId;
  const sites = await paginate("/proxy/network/integration/v1/sites");
  const hit = sites.find((x) => x.internalReference === site) || sites[0];
  if (!hit?.id) throw new Error("UniFi returned no sites for this API key");
  db.setSetting("unifi_site_id", hit.id);
  return hit.id;
}

export async function listConnectedClients() {
  const siteId = await resolveSiteId();
  const rows = await paginate(`/proxy/network/integration/v1/sites/${siteId}/clients`);
  return rows.map((c) => ({
    id: c.id,
    name: c.name || c.macAddress,
    mac: (c.macAddress || "").toLowerCase(),
    ip: c.ipAddress || null,
    type: c.type || null,
    connectedAt: c.connectedAt || null,
    lastSeen: c.connectedAt ? Date.parse(c.connectedAt) : Date.now(),
    online: true,
    blocked: isBlocked(c.access),
    access: c.access || null,
  }));
}

export async function listDpiCatalog() {
  const [apps, cats] = await Promise.all([
    paginate("/proxy/network/integration/v1/dpi/applications"),
    paginate("/proxy/network/integration/v1/dpi/categories"),
  ]);
  return {
    apps: apps.map((a) => ({ id: Number(a.id), name: a.name })),
    cats: cats.map((c) => ({ id: Number(c.id), name: c.name })),
  };
}

export async function getTraffic(startMs, endMs, mac) {
  const { site } = config();
  const qs = `start=${startMs}&end=${endMs}&includeUnidentified=true`;
  const path = mac
    ? `/proxy/network/v2/api/site/${site}/traffic/${encodeURIComponent(mac)}?${qs}&mac=${encodeURIComponent(mac)}`
    : `/proxy/network/v2/api/site/${site}/traffic?${qs}`;
  const json = await request(path);
  const rows = json?.client_usage_by_app || [];
  return rows.map((row) => ({
    client: {
      mac: (row.client?.mac || "").toLowerCase(),
      name: row.client?.name || row.client?.hostname || row.client?.mac,
      hostname: row.client?.hostname || null,
      wired: Boolean(row.client?.is_wired),
    },
    usage: (row.usage_by_app || []).map((u) => ({
      appId: Number(u.application),
      catId: Number(u.category),
      bytesRx: Number(u.bytes_received || 0),
      bytesTx: Number(u.bytes_transmitted || 0),
      totalBytes: Number(u.total_bytes || 0),
      activitySeconds: Number(u.activity_seconds || 0),
    })),
  }));
}

const FLOW_ARRAY_FIELDS = [
  "risk",
  "action",
  "direction",
  "protocol",
  "service",
  "source_mac",
  "source_ip",
  "source_host",
  "source_network_id",
  "destination_domain",
  "destination_ip",
  "destination_region",
  "policy",
  "policy_type",
  "source_port",
  "source_domain",
  "source_zone_id",
  "source_region",
  "destination_host",
  "destination_mac",
  "destination_port",
  "destination_network_id",
  "destination_zone_id",
  "in_network_id",
  "out_network_id",
  "next_ai_query",
  "except_for",
];

async function fetchFlowPages({ startMs, endMs, mac, maxPages, onTruncate }) {
  const flows = [];
  let page = 0;
  let hasNext = true;
  let reported = null;
  while (hasNext && page < maxPages) {
    const body = Object.fromEntries(FLOW_ARRAY_FIELDS.map((k) => [k, []]));
    if (mac) body.source_mac = [mac];
    body.timestampFrom = startMs;
    body.timestampTo = endMs;
    body.pageNumber = page;
    body.pageSize = 1000;
    body.search_text = "";
    body.skip_count = false;
    const { site } = config();
    const json = await request(`/proxy/network/v2/api/site/${site}/traffic-flows`, {
      method: "POST",
      body,
    });
    const data = json?.data || [];
    flows.push(...data);
    hasNext = Boolean(json?.has_next);
    if (reported == null && Number.isFinite(Number(json?.total_element_count))) {
      reported = Number(json.total_element_count);
    }
    page += 1;
    if (!data.length) break;
  }
  // Silence here used to hide real data loss: a busy 3-hour slice reports
  // total_element_count=10000 across 10 pages, and the old 6-page cap took 6000 of
  // them. UniFi returns newest-first, so what went missing was the oldest part of
  // the slice — whole playback sessions vanishing from the timeline.
  if (hasNext && onTruncate) onTruncate({ startMs, endMs, got: flows.length, reported });
  return flows;
}

// The connection record behind a security event (UU-C-071, UU-C-077). The System Log entry
// has only source, target and severity; the flow record of the same connection carries the
// rest — for an IPS hit an `ips` block (signature, id, category, UniFi's note), for a
// firewall block the policy — plus both ends and the traffic. Flows last ~4 days on the
// console, so this has to be read while they still exist. Narrow: a few minutes around the
// event, the source device's flows when its MAC is known.
export const SECURITY_DETAIL_VERSION = 2;
export async function findBlockedFlow({ ts, mac, srcIp, dstIp, ips = false }) {
  const flows = await fetchFlowPages({ startMs: Number(ts) - 180000, endMs: Number(ts) + 60000, mac: mac || undefined, maxPages: 10 });
  const candidates = flows.filter(
    (f) =>
      f &&
      (ips ? f.ips : f.action === "blocked") &&
      (!dstIp || f.destination?.ip === dstIp) &&
      (!srcIp || f.source?.ip === srcIp)
  );
  if (!candidates.length) return null;
  // The one closest in time to the event.
  const hit = candidates.reduce((best, f) => (Math.abs(Number(f.time || f.flow_start_time) - ts) < Math.abs(Number(best.time || best.flow_start_time) - ts) ? f : best));
  const policy = (hit.policies || []).find((p) => p?.type && p.type !== "FIREWALL") || (hit.policies || []).find((p) => p?.name) || {};
  const src = hit.source || {};
  const dst = hit.destination || {};
  const td = hit.traffic_data || {};
  const x = hit.ips || {};
  return {
    v: SECURITY_DETAIL_VERSION,
    time: Number(hit.time || hit.flow_start_time) || null,
    risk: hit.risk || null,
    action: hit.action || null,
    service: hit.service || null,
    protocol: hit.protocol || null,
    direction: hit.direction || null,
    policy: policy.name || null,
    policyType: policy.type || null,
    signature: x.signature || null,
    signatureId: Number(x.signature_id) || null,
    category: x.category_name || null,
    note: x.alarm_category_potential_risk || null,
    advanced: x.advanced_information || null,
    cve: x.relevant_cve || null,
    inNetwork: hit.in?.network_name || null,
    outNetwork: hit.out?.network_name || null,
    source: {
      name: src.client_name || null,
      ip: src.ip || null,
      mac: src.mac ? String(src.mac).toLowerCase() : null,
      hostname: src.host_name || null,
      manufacturer: src.client_oui || null,
      port: src.port ?? null,
      zone: src.zone_name || null,
      network: src.network_name || null,
      subnet: src.subnet || null,
      region: src.region || null,
    },
    destination: {
      name: dst.client_name || null,
      domain: (dst.domains || [])[0] || null,
      ip: dst.ip || null,
      port: dst.port ?? null,
      region: dst.region || null,
      zone: dst.zone_name || null,
      network: dst.network_name || null,
    },
    traffic: {
      durationMs: Number(hit.duration_milliseconds) || null,
      bytesTotal: Number(td.bytes_total) || null,
      bytesTx: Number(td.bytes_tx) || null,
      bytesRx: Number(td.bytes_rx) || null,
      packetsTotal: Number(td.packets_total) || null,
      packetsTx: Number(td.packets_tx) || null,
      packetsRx: Number(td.packets_rx) || null,
      count: Number(hit.count) || null,
    },
    // Kept flat for the list view.
    domain: (dst.domains || [])[0] || null,
    port: dst.port ?? null,
  };
}

// Raw UniFi flow objects carry ~40 fields; only these are ever read (classify.js
// hostsFromFlow / bytesFromFlow / timeFromFlow / annotateFlow, cache.js flowId).
// Projecting here keeps the cache an order of magnitude smaller on disk.
function slimFlow(flow) {
  const dest = flow.destination || {};
  const td = flow.traffic_data || {};
  const destination = {};
  if (dest.host_name != null) destination.host_name = dest.host_name;
  if (dest.client_name != null) destination.client_name = dest.client_name;
  if (dest.id != null) destination.id = dest.id;
  if (Array.isArray(dest.domains) && dest.domains.length) destination.domains = dest.domains;
  const rx = Number(td.bytes_rx || 0);
  const tx = Number(td.bytes_tx || 0);
  const start = Number(flow.flow_start_time || flow.time || 0);
  const end = Number(flow.flow_end_time || 0) || start + Number(flow.duration_milliseconds || 0);
  const slim = {
    flow_start_time: start,
    // UniFi reports how long the flow lasted; dropping it made every single-flow session
    // render as "0s" even when it moved 2.38 GB.
    flow_end_time: Math.max(start, end),
    source: { mac: String(flow.source?.mac || "").toLowerCase() },
    destination,
    traffic_data: { bytes_total: Number(td.bytes_total ?? rx + tx), bytes_rx: rx, bytes_tx: tx },
  };
  if (flow.id != null) slim.id = flow.id;
  if (flow.service) slim.service = flow.service;
  if (flow.action) slim.action = flow.action;
  return slim;
}

export async function getTrafficFlows({ startMs, endMs, mac } = {}) {
  const span = Math.max(0, Number(endMs) - Number(startMs));
  const sliceMs = mac || span <= 3 * 3600000 ? span || 1 : 3 * 3600000;
  // A 3-hour slice can genuinely hold 10k+ flows. The cap is a runaway guard, not a
  // budget — set it well above what a real slice needs, and shout if it is ever hit.
  const maxPages = FLOW_MAX_PAGES;
  const flows = [];
  const seen = new Set();
  let truncated = 0;
  for (let t = Number(startMs); t < Number(endMs); t += sliceMs) {
    const chunk = await fetchFlowPages({
      startMs: t,
      endMs: Math.min(t + sliceMs, Number(endMs)),
      mac,
      maxPages,
      onTruncate: ({ startMs: a, endMs: b, got, reported }) => {
        truncated += 1;
        console.warn(
          `flows TRUNCATED ${new Date(a).toISOString()}..${new Date(b).toISOString()} ` +
            `got=${got}${reported != null ? ` of >=${reported}` : ""} (hit ${maxPages}-page cap, has_next still true)`
        );
      },
    });
    for (const flow of chunk) {
      const id =
        flow.id ||
        `${flow.flow_start_time}|${flow.source?.mac}|${flow.destination?.host_name}|${flow.traffic_data?.bytes_total}`;
      if (seen.has(id)) continue;
      seen.add(id);
      flows.push(slimFlow(flow));
    }
  }
  if (truncated) {
    console.warn(`flows: ${truncated} slice(s) truncated in this fetch — timeline will be incomplete`);
  }
  return flows;
}

// The Network app's own System Log (the Logs page): client connects, disconnects and roams,
// threats blocked, admin changes, WAN alerts. Kept by the console for its "Data Retention"
// setting (90 days here — the oldest entry on 2026-10-05 was Jul 7), unlike flows (~4 days)
// and DPI (7 days). Paged; newest first. UU-C-051.
export async function getSystemLog({ startMs, endMs, pageSize = 500, maxPages = 200 } = {}) {
  const { site } = config();
  const out = [];
  for (let page = 0; page < maxPages; page += 1) {
    const json = await request(`/proxy/network/v2/api/site/${site}/system-log/all`, {
      method: "POST",
      body: { timestampFrom: Number(startMs), timestampTo: Number(endMs), pageSize, pageNumber: page },
    });
    const data = json?.data || [];
    for (const e of data) out.push(e);
    if (!data.length || page + 1 >= Number(json?.total_page_count || 0)) break;
  }
  return out;
}

// Live state for Wi-Fi quality, equipment health and the WAN strip (UU-C-056). These are
// the Network app's own endpoints; on Network 10.6.106 stat/sta, stat/device and
// stat/health answer with the API key (stat/event and stat/alarm do not).
async function siteStat(name) {
  const { site } = config();
  const json = await request(`/proxy/network/api/s/${site}/stat/${name}`);
  return json?.data || [];
}

export const getStations = () => siteStat("sta");
export const getDevices = () => siteStat("device");
export const getHealth = () => siteStat("health");

// Per-device daily totals (UU-C-057). UniFi keeps its daily scale for 90 days (stat/sysinfo:
// data_retention_time_in_hours_for_daily_scale = 2160), far longer than the 7 days of
// hourly DPI. One number per device per day, internet traffic only, buckets at local
// midnight — measured equal to the app's DPI per device within 0-10% for most devices.
export async function getDailyUser(startMs, endMs) {
  const { site } = config();
  const json = await request(`/proxy/network/api/s/${site}/stat/report/daily.user`, {
    method: "POST",
    body: { attrs: ["time", "rx_bytes", "tx_bytes"], start: Number(startMs), end: Number(endMs) },
  });
  return json?.data || [];
}

// Blocking does NOT live in the Integration API. Asked to block, that endpoint answers
// (verified on Network 10.6.106):
//   Invalid $.action value 'BLOCK'
//   (valid values: 'AUTHORIZE_GUEST_ACCESS', 'UNAUTHORIZE_GUEST_ACCESS')
// so the previous implementation could never have worked — it 400'd every time. The
// Network application's own API does support it, authenticates with the same API key,
// and is keyed by MAC rather than the Integration client id.
export async function setClientBlocked(mac, blocked) {
  const { site } = config();
  const json = await request(`/proxy/network/api/s/${site}/cmd/stamgr`, {
    method: "POST",
    body: { cmd: blocked ? "block-sta" : "unblock-sta", mac: String(mac).toLowerCase() },
  });
  // This API reports failure in the body with a 200, so check it rather than trusting
  // the status code.
  if (json?.meta?.rc && json.meta.rc !== "ok") {
    const err = new Error(`UniFi ${json.meta.rc}: ${json.meta.msg || "command rejected"}`);
    err.body = json;
    throw err;
  }
  return { ok: true, blocked: Boolean(json?.data?.[0]?.blocked ?? blocked) };
}

// Every client UniFi has ever seen, offline ones included (name, hostname, last_ip,
// fixed_ip, blocked). Used for blocking state and for naming local destinations.
export async function getKnownClients() {
  const { site } = config();
  const json = await request(`/proxy/network/api/s/${site}/rest/user`);
  return json?.data || [];
}

// Blocked state for every known client, not just the connected ones — a blocked device
// usually is not associated, so it would be missing from the active list.
export async function listBlockedMacs() {
  const out = new Set();
  for (const u of await getKnownClients()) {
    if (u?.blocked && u.mac) out.add(String(u.mac).toLowerCase());
  }
  return out;
}
