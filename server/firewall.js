// Firewall rules in plain words (UU-C-270). UniFi Network 9+ uses zone-based firewall policies:
// every rule goes from one zone (Internal = your networks, External = the internet, Gateway =
// the gateway itself, VPN, Hotspot, DMZ) to another, and the first matching rule by order
// decides. NetLens reads them hourly (read-only, `refreshFirewall` from health.refreshAir) and
// keeps the last copy in setting `firewall`; pages read only that.
import * as db from "./db.js";
import * as unifi from "./unifi.js";
import * as insights from "./insights.js";

const lower = (v) => String(v || "").toLowerCase();

// Read and keep the rules, the zones and the network names they point at.
export async function refreshFirewall() {
  const [policies, zones, nets, dns, filters] = await Promise.all([
    unifi.getFirewallPolicies(),
    unifi.getFirewallZones(),
    unifi.getNetworks().catch(() => []),
    unifi.getDnsRecords().catch(() => null),
    unifi.getContentFilters().catch(() => null),
  ]);
  // The rest of the Policy Engine; each list on its own, so one UniFi lacks does not stop the rest.
  const more = {};
  for (const k of ["qos", "objects", "portForwards", "nat", "routes", "trafficRules", "acl"]) more[k] = await unifi.getPolicyList(k).catch(() => null);
  if (!Array.isArray(policies) || !Array.isArray(zones)) return null;
  const netName = new Map(nets.map((n) => [n._id, { name: n.name, vlan: Number(n.vlan) || 1, subnet: n.ip_subnet || null }]));
  const keep = {
    at: Date.now(),
    zones: zones.map((z) => ({ id: z._id, name: z.name, key: z.zone_key || null, networks: (z.network_ids || []).map((id) => netName.get(id)?.name || "a network") })),
    networks: Object.fromEntries([...netName].map(([id, n]) => [id, n.name])),
    policies: policies.map((p) => ({
      id: p._id,
      name: p.name || "",
      description: p.description || "",
      enabled: p.enabled !== false,
      action: String(p.action || "").toUpperCase(),
      index: Number(p.index) || 0,
      predefined: Boolean(p.predefined),
      protocol: p.protocol || "all",
      ipVersion: p.ip_version || "BOTH",
      states: p.connection_state_type === "ALL" ? [] : p.connection_states || [],
      stateType: p.connection_state_type || "ALL",
      schedule: p.schedule || { mode: "ALWAYS" },
      logging: Boolean(p.logging),
      source: endpoint(p.source),
      destination: endpoint(p.destination),
    })),
    // Local DNS records (a name → an address on your network) and content filters (ads, family).
    dns: Array.isArray(dns) ? dns.map((r) => ({ id: r._id, enabled: r.enabled !== false, type: r.record_type || "A", name: r.key || "", value: r.value || "", ttl: Number(r.ttl) || 0, port: Number(r.port) || 0, priority: Number(r.priority) || 0 })) : null,
    // Speed rules: limit or prioritise (UniFi's QoS).
    qos: more.qos && more.qos.map((q) => ({ id: q._id, name: q.name || "", enabled: q.enabled !== false, index: Number(q.index) || 0, objective: q.objective || "", up: Number(q.upload_limit_kbps) || null, down: Number(q.download_limit_kbps) || null, line: q.wan_or_vpn_network || null, source: endpoint(q.source), destination: endpoint(q.destination), schedule: q.schedule || { mode: "ALWAYS" } })),
    // Objects (Network 9.3+): one target (networks or devices) with what to secure, route, limit.
    objects: more.objects && more.objects.map((o) => ({
      id: o.id || o._id,
      name: o.name || "",
      enabled: o.enabled !== false,
      targets: (o.targets || []).map((t) => ({ type: t.type, value: t.value })),
      secure: o.secure?.enabled ? { mode: o.secure.internet?.mode || null, everything: Boolean(o.secure.internet?.everything), apps: on(o.secure.internet?.apps), domains: on(o.secure.internet?.domains), ips: on(o.secure.internet?.ip_addresses), regions: on(o.secure.internet?.regions), schedule: o.secure.internet?.schedule || null } : null,
      route: o.route?.enabled ? { via: o.route.network_id || o.route.interface || null, apps: on(o.route.apps), domains: on(o.route.domains), ips: on(o.route.ip_addresses), regions: on(o.route.regions) } : null,
      qos: o.qos?.enabled ? { mode: o.qos.mode || null, down: o.qos.download_limit?.enabled ? Number(o.qos.download_limit.limit) || null : null, up: o.qos.upload_limit?.enabled ? Number(o.qos.upload_limit.limit) || null : null } : null,
    })),
    portForwards: more.portForwards && more.portForwards.map((f) => ({ id: f._id, name: f.name || "", enabled: f.enabled !== false, port: String(f.dst_port || ""), to: f.fwd || "", toPort: String(f.fwd_port || ""), proto: f.proto || "tcp_udp", from: f.src && f.src !== "any" ? f.src : null, line: f.pfwd_interface || null })),
    nat: more.nat && more.nat.map((n) => ({ id: n._id, name: n.description || n.name || "", enabled: n.enabled !== false, type: n.type || "", predefined: Boolean(n.is_predefined || n.predefined) })),
    routes: more.routes && more.routes.map((r) => ({ id: r._id, name: r.description || r.name || "", enabled: r.enabled !== false, target: r.matching_target || "", via: r.network_id || r.next_hop || null, who: (r.target_devices || []).map((t) => t.client_mac || t.network_id || t.type), domains: (r.domains || []).map((d) => d.domain || d), ips: (r.ip_addresses || []).map((i) => i.ip_or_subnet || i), regions: r.regions || [], killSwitch: Boolean(r.kill_switch_enabled) })),
    trafficRules: more.trafficRules && more.trafficRules.map((r) => ({ id: r._id, name: r.description || r.name || "", enabled: r.enabled !== false, action: r.action || "", target: r.matching_target || "", who: (r.target_devices || []).map((t) => t.client_mac || t.network_id || t.type), apps: r.app_ids || [], domains: (r.domains || []).map((d) => d.domain || d), down: Number(r.bandwidth_limit?.download_limit_kbps) || null, up: Number(r.bandwidth_limit?.upload_limit_kbps) || null, schedule: r.schedule || { mode: "ALWAYS" } })),
    acl: more.acl && more.acl.map((a) => ({ id: a.id || a._id, name: a.name || "", enabled: a.enabled !== false, action: a.action || "" })),
    filters: Array.isArray(filters) ? filters.map((f) => ({ id: f._id, name: f.name || "", enabled: f.enabled !== false, categories: f.categories || [], networks: f.network_ids || [], macs: f.client_macs || [], allow: f.allow_list || [], block: f.block_list || [], safeSearch: f.safe_search || [], schedule: f.schedule || { mode: "ALWAYS" } })) : null,
  };
  db.setSetting("firewall", JSON.stringify(keep));
  return keep;
}

// An Object's "{ enabled, values }" list, or nothing.
const on = (x) => (x?.enabled && Array.isArray(x.values) && x.values.length ? x.values : []);

// Only what the description needs.
function endpoint(e = {}) {
  return {
    zone: e.zone_id || null,
    target: e.matching_target || "ANY",
    not: Boolean(e.match_opposite_networks || e.match_opposite_ips || e.match_opposite_ports),
    macs: e.client_macs || [],
    networks: e.network_ids || [],
    ips: e.ips || [],
    apps: e.app_ids || [],
    appCats: e.app_category_ids || [],
    domains: e.web_domains || [],
    regions: e.regions || [],
    port: e.port_matching_type === "SPECIFIC" ? String(e.port || "") : e.port_matching_type === "OBJECT" ? "a port list" : null,
  };
}

// Well-known public DNS addresses, so a rule blocking them reads as such.
const KNOWN_IPS = [
  [/^1\.(1\.1|0\.0)\.\d+$|^2606:4700:4700::/, "Cloudflare DNS"],
  [/^8\.8\.(8\.8|4\.4)$|^2001:4860:4860::/, "Google DNS"],
  [/^9\.9\.9\.\d+$|^149\.112\.112\.\d+$|^2620:fe::/, "Quad9 DNS"],
  [/^208\.67\.(222|220)\.\d+$|^2620:119:/, "OpenDNS"],
  [/^17\.0\.0\.0\/8$/, "Apple (17.0.0.0/8)"],
];
const ZONE_WORDS = { internal: "your networks", external: "the internet", gateway: "the gateway itself", vpn: "VPN connections", hotspot: "the guest hotspot", dmz: "the DMZ" };
const PORTS = { 53: "DNS", 80: "web (HTTP)", 443: "web (HTTPS)", 853: "encrypted DNS (DNS over TLS)", 5353: "device discovery (mDNS)", 546: "IPv6 addresses (DHCPv6)", 547: "IPv6 addresses (DHCPv6)", 22: "SSH", 3389: "remote desktop" };

function list(items, max = 6) {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} and ${items.length - max} more`;
}

// "everything in your networks", "the kids network", "Living room TV", "Cloudflare DNS, Google DNS".
function describe(e, zone, ctx) {
  const zoneWord = ZONE_WORDS[zone?.key] || zone?.name || "anywhere";
  const not = e.not ? "anything except " : "";
  switch (e.target) {
    case "CLIENT":
      return { text: `${not}${list(e.macs.map((m) => ctx.deviceName(lower(m))))}`, items: e.macs.map((m) => ({ mac: lower(m), name: ctx.deviceName(lower(m)) })) };
    case "NETWORK": {
      const names = e.networks.map((id) => ctx.networks[id] || "a network");
      return { text: `${not}the ${list(names)} network${names.length === 1 ? "" : "s"}`, items: names };
    }
    case "IP": {
      const labels = new Map();
      const other = [];
      for (const ip of e.ips) {
        const k = KNOWN_IPS.find(([re]) => re.test(ip))?.[1];
        if (k) labels.set(k, (labels.get(k) || 0) + 1);
        else other.push(ip);
      }
      const parts = [...labels.keys(), ...other];
      return { text: `${not}${parts.length ? list(parts) : "some addresses"}${e.ips.length > 1 ? ` (${e.ips.length} addresses)` : ""}`, items: e.ips };
    }
    case "APP": {
      const names = [...e.apps.map((id) => ctx.appName(id)), ...e.appCats.map((id) => ctx.catName(id))];
      return { text: `${not}the app${names.length === 1 ? "" : "s"} ${list(names)}`, items: names };
    }
    case "APP_CATEGORY": {
      const names = e.appCats.map((id) => ctx.catName(id));
      return { text: `${not}${list(names)} apps`, items: names };
    }
    case "WEB":
      return { text: `${not}${list(e.domains)}`, items: e.domains };
    case "REGION":
      return { text: `${not}${list(e.regions)}`, items: e.regions };
    default:
      return { text: `${zone?.key === "internal" || zone?.key === "external" || zone?.key === "gateway" ? "" : "anything in "}${zoneWord}`, items: [] };
  }
}

function portText(port, protocol) {
  if (!port) return null;
  const words = port.split(",").map((p) => p.trim()).map((p) => (PORTS[p] ? `${PORTS[p]} (port ${p})` : /-/.test(p) ? `ports ${p}` : `port ${p}`));
  return `${words.join(", ")}${protocol && protocol !== "all" && protocol !== "tcp_udp" ? ` over ${protocol.toUpperCase()}` : ""}`;
}

function scheduleText(s) {
  if (!s || s.mode === "ALWAYS") return null;
  const days = (s.repeat_on_days || []).map((d) => d.slice(0, 1).toUpperCase() + d.slice(1, 3)).join(", ");
  const time = s.time_all_day ? "all day" : s.time_range_start && s.time_range_end ? `${s.time_range_start}–${s.time_range_end}` : "";
  if (s.mode === "EVERY_DAY") return `every day ${time}`.trim();
  if (s.mode === "EVERY_WEEK") return `${days || "some days"} ${time}`.trim();
  if (s.mode === "ONE_TIME_ONLY") return `once, ${s.date || ""} ${time}`.trim();
  if (s.mode === "CUSTOM") return `${days || "custom days"} ${time}`.trim();
  return String(s.mode).toLowerCase().replace(/_/g, " ");
}

// What a built-in rule is for, in a sentence.
function builtinNote(p) {
  if (/return traffic/i.test(p.name)) return "answers to connections started from the other side";
  if (/invalid/i.test(p.name)) return "drops broken or forged packets";
  if (/mdns/i.test(p.name)) return "lets devices find each other (printers, casting)";
  if (/neighbor|router adv|dhcpv6/i.test(p.name)) return "lets IPv6 from your provider work";
  if (/allow all/i.test(p.name)) return "the default when nothing above matched";
  if (/block all/i.test(p.name)) return "the default when nothing above matched";
  return null;
}

const DEFAULT_INDEX = 2147483647;

// UniFi's content-filter categories in words.
const FILTER_WORDS = { ADVERTISEMENT: "ads and trackers", FAMILY: "adult content (family filter)", WORK: "non-work sites", MALWARE: "malware", SOCIAL_MEDIA: "social media", GAMBLING: "gambling", GAMING: "games" };
const filterWord = (c) => FILTER_WORDS[c] || String(c).toLowerCase().replace(/_/g, " ");

// The page: your rules in order, then how the zones treat each other by default, then
// UniFi's built-in rules. `blocks` = the Protection page's block counts per rule name.
export function firewallSummary({ blocks = new Map(), now = Date.now() } = {}) {
  let fw = null;
  try {
    fw = JSON.parse(db.getSetting("firewall", "null"));
  } catch {
    fw = null;
  }
  if (!fw) return { at: null, zones: [], rules: [], builtin: [], matrix: [], dns: null, filters: null };
  const names = insights.names();
  const maps = db.dpiMaps();
  const ctx = {
    networks: fw.networks || {},
    deviceName: (mac) => names(mac) || mac,
    appName: (id) => maps.apps[id] || maps.apps[(Number(id) >> 16 << 16) + (Number(id) & 0xffff)] || `app ${id}`,
    catName: (id) => maps.cats[id] || `category ${id}`,
  };
  const zoneOf = new Map(fw.zones.map((z) => [z.id, z]));
  const used = (z) => z && (z.networks.length || z.key === "external" || z.key === "gateway");
  const shape = (p) => {
    const from = zoneOf.get(p.source.zone);
    const to = zoneOf.get(p.destination.zone);
    const src = describe(p.source, from, ctx);
    const dst = describe(p.destination, to, ctx);
    const port = portText(p.destination.port, p.protocol);
    const action = p.action === "ALLOW" ? "allow" : p.action === "REJECT" ? "reject" : "block";
    const b = blocks.get(p.name) || null;
    return {
      id: p.id,
      name: p.name,
      description: p.description || null,
      enabled: p.enabled,
      action,
      index: p.index,
      from: { zone: from?.name || null, zoneKey: from?.key || null, kind: p.source.target, text: src.text, items: src.items },
      to: { zone: to?.name || null, zoneKey: to?.key || null, kind: p.destination.target, text: dst.text, items: dst.items },
      port,
      protocol: p.protocol,
      ipVersion: p.ipVersion !== "BOTH" ? p.ipVersion.replace("IPV", "IPv") + " only" : null,
      only: p.stateType === "RESPOND_ONLY" ? "answers only" : p.states.length ? p.states.map((s) => s.toLowerCase()).join(", ") + " connections only" : null,
      schedule: scheduleText(p.schedule),
      logging: p.logging,
      note: p.predefined ? builtinNote(p) : null,
      blocks: b ? { connections: b.connections, incidents: b.incidents, devices: b.devices } : null,
      zonesInUse: used(from) && used(to),
    };
  };
  const all = fw.policies.map(shape);
  const rules = all.filter((r, i) => !fw.policies[i].predefined).sort((a, b) => a.index - b.index);
  const builtin = all.filter((r, i) => fw.policies[i].predefined && fw.policies[i].index !== DEFAULT_INDEX && r.zonesInUse).sort((a, b) => a.index - b.index || String(a.from.zone).localeCompare(String(b.from.zone)));
  // The default between each pair of zones in use: the last rule (index 2147483647).
  const zones = fw.zones.filter(used).sort((a, b) => ["internal", "gateway", "external"].indexOf(a.key) - ["internal", "gateway", "external"].indexOf(b.key));
  const matrix = zones.map((z) => ({
    zone: z.name,
    key: z.key,
    cells: zones.map((t) => {
      const p = fw.policies.find((x) => x.predefined && x.index === DEFAULT_INDEX && x.source.zone === z.id && x.destination.zone === t.id);
      const answers = fw.policies.some((x) => x.predefined && x.stateType === "RESPOND_ONLY" && x.source.zone === z.id && x.destination.zone === t.id);
      const own = rules.filter((r) => r.enabled && r.from.zone === z.name && r.to.zone === t.name).length;
      return { to: t.name, action: p ? (p.action === "ALLOW" ? "allow" : "block") : null, answers, own };
    }),
  }));
  // Which device an address belongs to, for the DNS records.
  const byIp = new Map();
  for (const c of db.listStoredClients()) if (c.ip) byIp.set(c.ip, c.name || c.hostname || null);
  const dns = fw.dns
    ? fw.dns
        .map((r) => ({ ...r, device: /^(A|AAAA)$/.test(r.type) ? byIp.get(r.value) || null : null }))
        .sort((a, b) => a.name.localeCompare(b.name))
    : null;
  const filters = fw.filters
    ? fw.filters.map((f) => ({
        id: f.id,
        name: f.name,
        enabled: f.enabled,
        blocks: f.categories.map(filterWord),
        who: [...f.networks.map((id) => `the ${ctx.networks[id] || "a"} network`), ...f.macs.map((m) => ctx.deviceName(lower(m)))],
        allow: f.allow,
        block: f.block,
        safeSearch: Array.isArray(f.safeSearch) ? f.safeSearch.map((x) => String(x).toLowerCase().replace(/^./, (c) => c.toUpperCase())) : f.safeSearch ? ["on"] : [],
        schedule: scheduleText(f.schedule),
      }))
    : null;
  // Speed rules, Objects and the rest of the Policy Engine, in words.
  const lineName = (id) => (id ? ctx.networks[id] || "a line" : "the internet line");
  const mbit = (kbps) => (kbps >= 1000 ? `${+(kbps / 1000).toFixed(1)} Mbps` : `${kbps} kbps`);
  const whoOf = (items) => items.map((x) => (/^([0-9a-f]{2}:){5}/i.test(x) ? ctx.deviceName(lower(x)) : ctx.networks[x] ? `the ${ctx.networks[x]} network` : x));
  const qos = fw.qos
    ? fw.qos
        .map((q) => {
          const src = describe(q.source, { key: "internal" }, ctx);
          const dst = describe(q.destination, { key: "external" }, ctx);
          const what = q.objective === "PRIORITIZE" ? "Put first" : q.objective === "LIMIT" ? "Limit" : q.objective.toLowerCase();
          const limits = [q.down ? `download to ${mbit(q.down)}` : null, q.up ? `upload to ${mbit(q.up)}` : null].filter(Boolean).join(", ");
          const whoText = q.source.target === "ANY" ? (q.destination.target === "ANY" ? "all traffic" : "traffic") : `${src.text}'s traffic`;
          const toText = q.destination.target === "ANY" ? "" : ` to ${dst.text}`;
          return { id: q.id, name: q.name, enabled: q.enabled, text: `${what} ${whoText}${toText}${limits ? `: ${limits}` : ""} on ${lineName(q.line)}`, schedule: scheduleText(q.schedule) };
        })
        .sort((a, b) => a.name.localeCompare(b.name))
    : null;
  const objects = fw.objects
    ? fw.objects.map((o) => {
        const who = o.targets.map((t) => (t.type === "NETWORK_ID" ? `the ${ctx.networks[t.value] || "a"} network` : /MAC|CLIENT/.test(t.type) ? ctx.deviceName(lower(t.value)) : t.value));
        const parts = [];
        if (o.secure) {
          const items = [...o.secure.apps.map((id) => ctx.appName(id)), ...o.secure.domains, ...o.secure.ips.map((ip) => KNOWN_IPS.find(([re]) => re.test(ip))?.[1] || ip), ...o.secure.regions];
          const verb = o.secure.mode === "ALLOWLIST" ? "only allow" : "block";
          parts.push(o.secure.everything ? (verb === "block" ? "block the internet" : "allow the internet") : items.length ? `${verb} ${list(items)}` : `${verb} (nothing listed)`);
        }
        if (o.route) parts.push(`send ${[...o.route.apps.map((id) => ctx.appName(id)), ...o.route.domains, ...o.route.ips, ...o.route.regions].join(", ") || "all traffic"} through ${lineName(o.route.via)}`);
        if (o.qos) parts.push([o.qos.down ? `download at most ${mbit(o.qos.down)}` : null, o.qos.up ? `upload at most ${mbit(o.qos.up)}` : null].filter(Boolean).join(", ") || "speed rules");
        return { id: o.id, name: o.name, enabled: o.enabled, who, text: parts.join("; ") || "nothing set" };
      })
    : null;
  const ipName = (ip) => byIp.get(ip) || null;
  const other = [
    {
      kind: "Port forwards",
      note: "openings from the internet to a device inside",
      items: fw.portForwards?.map((f) => ({ id: f.id, name: f.name, enabled: f.enabled, text: `Opens port ${f.port}${f.proto && f.proto !== "tcp_udp" ? ` (${f.proto.toUpperCase()})` : ""} from ${f.from ? `only ${f.from}` : "anywhere on the internet"} to ${ipName(f.to) ? `${ipName(f.to)} (${f.to})` : f.to}${f.toPort && f.toPort !== f.port ? ` port ${f.toPort}` : ""}` })),
    },
    {
      kind: "Traffic routes",
      note: "traffic sent through a chosen line or VPN",
      items: fw.routes?.map((r) => ({ id: r.id, name: r.name, enabled: r.enabled, text: `Send ${whoOf(r.who).join(", ") || "everyone"}: ${r.target === "INTERNET" ? "internet traffic" : list([...r.domains, ...r.ips, ...r.regions]) || r.target.toLowerCase()} through ${lineName(r.via)}${r.killSwitch ? "; cut off if that line is down" : ""}` })),
    },
    {
      kind: "Traffic rules (older)",
      note: "blocks and speed limits from before the zone-based firewall",
      items: fw.trafficRules?.map((r) => ({
        id: r.id,
        name: r.name,
        enabled: r.enabled,
        text: `${r.action === "BLOCK" ? "Block" : r.action === "ALLOW" ? "Allow" : "Limit"} ${whoOf(r.who).join(", ") || "everyone"} → ${r.apps.length ? `the apps ${list(r.apps.map((id) => ctx.appName(id)))}` : r.domains.length ? list(r.domains) : r.target.toLowerCase().replace(/_/g, " ")}${r.down || r.up ? ` (${[r.down ? `down ${mbit(r.down)}` : null, r.up ? `up ${mbit(r.up)}` : null].filter(Boolean).join(", ")})` : ""}`,
        schedule: scheduleText(r.schedule),
      })),
    },
    { kind: "NAT rules", note: "address translation", items: fw.nat?.filter((n) => !n.predefined).map((n) => ({ id: n.id, name: n.name, enabled: n.enabled, text: n.type ? `${n.type.toLowerCase()} rule` : "NAT rule" })) },
    { kind: "Switch ACLs", note: "rules inside the switches", items: fw.acl?.map((a) => ({ id: a.id, name: a.name, enabled: a.enabled, text: (a.action || "").toLowerCase() || "rule" })) },
  ].map((g) => ({ ...g, read: Array.isArray(g.items), items: g.items || [] }));
  // Firewall rules UniFi made from an Object are the owner's too (they share its name).
  const objectNames = new Set((fw.objects || []).map((o) => o.name));
  for (const r of builtin) if (objectNames.has(r.name)) r.fromObject = r.name;
  const fromObjects = builtin.filter((r) => r.fromObject);
  return {
    at: fw.at,
    dns,
    filters,
    qos,
    objects,
    other,
    stale: fw.at ? now - fw.at > 3 * 3600e3 : true,
    zones: fw.zones.map((z) => ({ name: z.name, key: z.key, words: ZONE_WORDS[z.key] || z.name, networks: z.networks, inUse: Boolean(used(z)) })),
    rules: [...rules, ...fromObjects].sort((a, b) => a.index - b.index),
    builtin: builtin.filter((r) => !r.fromObject),
    matrix,
    hiddenBuiltin: all.filter((r, i) => fw.policies[i].predefined && !r.zonesInUse).length,
  };
}
