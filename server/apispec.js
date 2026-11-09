// The API for scripts and assistants (UU-C-227): one table that the MCP endpoint (server/mcp.js),
// the OpenAPI description (/api/openapi.json) and the access key's write allowlist are all built
// from, so the three cannot drift apart. scripts/check-api-spec.mjs checks every entry against
// the routes in server/index.js.
//
// A tool is { name, method, path, summary, params, write?, destructive? }. `params` maps a name
// to { in: "query" | "path" | "body", type, description, enum?, required? }. Write tools are
// the "safe changes" a full key may make; nothing here blocks a device, changes settings, the
// password or the key, imports or exports history, or stops NetLens.

const MAC = { type: "string", description: "Device MAC address: six two-digit hex pairs joined by colons, lower case (as list_devices gives it)." };
const PERIOD = {
  period: { in: "query", type: "string", enum: ["today", "yesterday", "7d", "14d", "30d", "90d", "custom"], description: "Time range. Default today. 'custom' needs date." },
  date: { in: "query", type: "string", description: "A day as YYYY-MM-DD, with period=custom." },
  from: { in: "query", type: "integer", description: "Start of a stretch within one day, epoch ms (with to; at most 24 h). Overrides period." },
  to: { in: "query", type: "integer", description: "End of that stretch, epoch ms." },
};
const DAYS4 = { in: "query", type: "integer", enum: [1, 7, 30, 90], description: "How many days back. Default 1." };
const DAY_OR_DAYS = {
  days: { in: "query", type: "integer", enum: [3, 7, 14, 30, 90], description: "The last N days up to now. Overrides date." },
  date: { in: "query", type: "string", description: "One day as YYYY-MM-DD. Default today." },
};

export const TOOLS = [
  // ---- read ----------------------------------------------------------------------------------
  { name: "get_status", method: "GET", path: "/api/health", summary: "Whether NetLens can reach the UniFi console, and when it last read it.", params: {} },
  { name: "get_data_status", method: "GET", path: "/api/cache", summary: "What NetLens has stored: days saved, gaps, and the last refresh.", params: {} },
  { name: "get_overview", method: "GET", path: "/api/findings", summary: "The Overview page: findings worth attention (problems, unusual traffic, new devices, alerts) for a day or the last N days.", params: { ...DAY_OR_DAYS } },
  { name: "get_day_grid", method: "GET", path: "/api/day", summary: "Traffic per device per hour for a day (or per day for the last N days): who was active when.", params: { ...DAY_OR_DAYS } },
  { name: "get_usage", method: "GET", path: "/api/report", summary: "The Usage report: traffic and time in use by device, app and category, with a chart, for a period. Narrow it to one device, app or category.", params: { ...PERIOD, mac: { in: "query", ...MAC, description: "Only this device." }, appId: { in: "query", type: "string", description: "Only this app (an id from search_apps). Default all." }, category: { in: "query", type: "string", description: "Only this category (an id from search_apps). Default all." } } },
  { name: "search_apps", method: "GET", path: "/api/apps", summary: "Find UniFi app and category ids by name, for get_usage and add_alert.", params: { q: { in: "query", type: "string", description: "Part of an app or category name." } } },
  { name: "list_sites", method: "GET", path: "/api/sites", summary: "Websites and services devices connected to, from stored connection records (not a DNS log).", params: { ...PERIOD, mac: { in: "query", ...MAC, description: "Only this device." }, group: { in: "query", type: "string", enum: ["site", "domain"], description: "Group by site (default) or by exact domain." }, q: { in: "query", type: "string", description: "Only names containing this text." }, cat: { in: "query", type: "string", description: "Comma-separated site categories to keep." }, bg: { in: "query", type: "string", enum: ["1"], description: "1 = include background services (CDNs, telemetry)." } } },
  { name: "get_site_connections", method: "GET", path: "/api/sites/hits", summary: "The newest connections (up to 50) behind one row of list_sites.", params: { key: { in: "query", type: "string", required: true, description: "The row's key from list_sites." }, ...PERIOD, mac: { in: "query", ...MAC, description: "Only this device." }, group: { in: "query", type: "string", enum: ["site", "domain"], description: "Same grouping as the list_sites call." } } },
  { name: "list_devices", method: "GET", path: "/api/devices", summary: "Every device UniFi knows: name, maker, address, online or not, last seen, and NetLens' own presence checks.", params: {} },
  { name: "list_online_clients", method: "GET", path: "/api/clients", summary: "Devices connected right now, with live traffic and blocked state.", params: { scope: { in: "query", type: "string", enum: ["online", "all"], description: "online (default) or all known devices." } } },
  { name: "get_device_presence", method: "GET", path: "/api/devices/{mac}/presence", summary: "When a device was online, on the network without UniFi seeing it, or off.", params: { mac: { in: "path", ...MAC, required: true }, days: { in: "query", type: "integer", description: "1 to 90. Default 7." } } },
  { name: "get_device_host", method: "GET", path: "/api/devices/{mac}/host", summary: "For a virtual machine or container: which device it runs on, and how that was worked out.", params: { mac: { in: "path", ...MAC, required: true } } },
  { name: "get_network_map", method: "GET", path: "/api/network", summary: "The network map: gateway, switches and access points with CPU, temperature, ports, radios and the devices on each. Optionally as it was at a past moment.", params: { at: { in: "query", type: "integer", description: "Epoch ms within the last 90 days. Omit for live." } } },
  { name: "get_network_timeline", method: "GET", path: "/api/network/timeline", summary: "The whole network over time: internet speed and latency, device counts, restarts, channel and port changes.", params: { days: DAYS4 } },
  { name: "get_equipment_history", method: "GET", path: "/api/network/history", summary: "One switch, access point or gateway over time: CPU, memory, temperature, clients, restarts.", params: { mac: { in: "query", ...MAC, required: true }, days: DAYS4 } },
  { name: "get_gateway", method: "GET", path: "/api/gateway", summary: "The gateway right now: internet line, CPU, memory, temperatures.", params: {} },
  { name: "get_equipment", method: "GET", path: "/api/equipment", summary: "Every switch and access point over a period: load, clients, problems.", params: { ...PERIOD } },
  { name: "get_wifi", method: "GET", path: "/api/wifi", summary: "Wi-Fi quality: signal and band per device over a period, or one device in detail.", params: { ...PERIOD, mac: { in: "query", ...MAC, description: "One device in detail." } } },
  { name: "get_wifi_joins", method: "GET", path: "/api/wifi-joins", summary: "Wi-Fi joins and leaves, roams between access points.", params: { days: { in: "query", type: "integer", description: "1 to 90. Default 1." }, mac: { in: "query", ...MAC, description: "Only this device." } } },
  { name: "get_security", method: "GET", path: "/api/threats", summary: "The Protection page: intrusion attempts, traffic blocked by firewall rules, ads and trackers blocked.", params: { ...PERIOD } },
  { name: "get_blocked_connections", method: "GET", path: "/api/threats/blocked", summary: "The connections behind one blocked-traffic incident from get_security.", params: { mac: { in: "query", ...MAC, required: true }, from: { in: "query", type: "integer", required: true, description: "Incident start, epoch ms." }, to: { in: "query", type: "integer", required: true, description: "Incident end, epoch ms." }, rule: { in: "query", type: "string", description: "The blocking rule's name." }, kind: { in: "query", type: "string", enum: ["ad"], description: "ad = an ad or tracker incident." }, site: { in: "query", type: "string", description: "With kind=ad: the site." } } },
  { name: "list_alerts", method: "GET", path: "/api/alerts", summary: "Usage alert rules (daily time or data limits), today's value for each, and the last 30 days of alerts that fired.", params: {} },
  { name: "get_syslog_status", method: "GET", path: "/api/siem", summary: "Whether NetLens is receiving UniFi's forwarded system log, and how much.", params: {} },

  // ---- safe changes (a full key, a logged-in browser, or no password) -------------------------
  { name: "rename_device", method: "POST", path: "/api/devices/{mac}/name", write: true, summary: "Set a device's name, in UniFi and NetLens. An empty name returns to UniFi's own.", params: { mac: { in: "path", ...MAC, required: true }, name: { in: "body", type: "string", required: true, description: "Up to 64 characters." } } },
  { name: "set_device_host", method: "POST", path: "/api/devices/{mac}/host", write: true, summary: "Say which device a virtual machine or container runs on.", params: { mac: { in: "path", ...MAC, required: true }, host: { in: "body", type: ["string", "null"], required: true, description: "The host's MAC, 'none' for no host, or null to go back to automatic detection." } } },
  { name: "check_device", method: "POST", path: "/api/devices/{mac}/probe", write: true, summary: "Check now whether a device answers on the network (ping and common ports, local addresses only).", params: { mac: { in: "path", ...MAC, required: true } } },
  { name: "add_alert", method: "POST", path: "/api/alerts", write: true, summary: "Add a daily usage alert: a time (minutes) or data (bytes) limit, for one device or all, one app or category or all traffic.", params: { metric: { in: "body", type: "string", enum: ["time", "bytes"], required: true, description: "time = minutes in use, bytes = data." }, limit: { in: "body", type: "integer", required: true, description: "Minutes or bytes per day, above zero." }, mac: { in: "body", ...MAC, description: "One device; omit for any device." }, macLabel: { in: "body", type: "string", description: "The device's name, for display." }, app: { in: "body", type: "string", description: "An app id from search_apps." }, appLabel: { in: "body", type: "string", description: "The app's name, for display." }, cat: { in: "body", type: "string", description: "A category id (ignored when app is set)." }, catLabel: { in: "body", type: "string", description: "The category's name, for display." } } },
  { name: "set_alert_enabled", method: "POST", path: "/api/alerts/{id}", write: true, summary: "Turn an alert rule on or off.", params: { id: { in: "path", type: "integer", required: true, description: "Rule id from list_alerts." }, enabled: { in: "body", type: "boolean", required: true, description: "true = on." } } },
  { name: "delete_alert", method: "DELETE", path: "/api/alerts/{id}", write: true, destructive: true, summary: "Delete an alert rule and its history.", params: { id: { in: "path", type: "integer", required: true, description: "Rule id from list_alerts." } } },
  { name: "hide_finding", method: "POST", path: "/api/findings/hidden", write: true, summary: "Hide an Overview finding (it returns if it gets more serious), or show it again.", params: { key: { in: "body", type: "string", required: true, description: "The finding's id without its trailing date or time, e.g. link-<mac> or alert-<rule id>." }, level: { in: "body", type: "string", enum: ["info", "warn", "bad"], description: "The finding's level now." }, title: { in: "body", type: "string", description: "Its title, for the hidden list." }, hidden: { in: "body", type: "boolean", description: "false = show it again. Default true." } } },
  { name: "refresh_data", method: "POST", path: "/api/cache/delta", write: true, summary: "Read everything new from UniFi now, as the 5-minute update does. Can take a minute.", params: {} },
];

const toRegex = (path) => new RegExp(`^${path.replace(/\{[^}]+\}/g, "[^/]+")}$`);
const WRITES = TOOLS.filter((t) => t.write).map((t) => ({ method: t.method, re: toRegex(t.path) }));
// May a full key make this request? GETs are checked separately (any key may read).
export const isKeyWrite = (method, path) => WRITES.some((w) => w.method === method && w.re.test(path));

function schemaOf(p) {
  const s = { type: p.type, description: p.description };
  if (p.enum) s.enum = p.enum;
  return s;
}

// JSON Schema for a tool's arguments (MCP inputSchema).
export function inputSchema(tool) {
  const properties = {};
  const required = [];
  for (const [k, p] of Object.entries(tool.params)) {
    properties[k] = schemaOf(p);
    if (p.required) required.push(k);
  }
  return { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

// Split a tool call's arguments into the URL and the JSON body.
export function requestOf(tool, args = {}) {
  let path = tool.path;
  const query = new URLSearchParams();
  const body = {};
  for (const [k, p] of Object.entries(tool.params)) {
    const v = args[k];
    if (v === undefined || (v === null && p.in !== "body")) {
      if (p.required) throw new Error(`${k} is required`);
      continue;
    }
    if (p.in === "path") path = path.replace(`{${k}}`, encodeURIComponent(String(v).toLowerCase()));
    else if (p.in === "query") query.set(k, String(v));
    else body[k] = v;
  }
  const extra = Object.keys(args).filter((k) => !tool.params[k]);
  if (extra.length) throw new Error(`unknown argument${extra.length > 1 ? "s" : ""}: ${extra.join(", ")}`);
  const q = query.toString();
  return { method: tool.method, url: q ? `${path}?${q}` : path, body: tool.method === "GET" ? null : body };
}

// OpenAPI 3.1 description of the same routes.
export function openapi(version) {
  const paths = {};
  for (const t of TOOLS) {
    const parameters = [];
    const props = {};
    const required = [];
    for (const [k, p] of Object.entries(t.params)) {
      if (p.in === "body") {
        props[k] = schemaOf(p);
        if (p.required) required.push(k);
      } else parameters.push({ name: k, in: p.in, required: p.in === "path" || Boolean(p.required), description: p.description, schema: { type: p.type, ...(p.enum ? { enum: p.enum } : {}) } });
    }
    const op = {
      operationId: t.name,
      summary: t.summary,
      tags: [t.write ? "changes" : "read"],
      ...(parameters.length ? { parameters } : {}),
      ...(t.method !== "GET" ? { requestBody: { required: required.length > 0, content: { "application/json": { schema: { type: "object", properties: props, ...(required.length ? { required } : {}) } } } } } : {}),
      responses: {
        200: { description: "JSON.", content: { "application/json": { schema: { type: "object" } } } },
        400: { description: "A parameter is not valid." },
        401: { description: "Login or a valid access key required." },
        403: { description: "The access key may not do this (a read key and a change)." },
      },
    };
    (paths[t.path] ||= {})[t.method.toLowerCase()] = op;
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "NetLens",
      version: version || "dev",
      description: "A UniFi network's usage, devices, Wi-Fi, equipment and security, as NetLens stores it. With a login password set, send an access key as Authorization: Bearer <key> (Settings › API and AI access): a read key opens the 'read' operations, a full key also the 'changes'. Without a password everything is open on the LAN. The same operations are offered as MCP tools at /mcp.",
    },
    servers: [{ url: "/" }],
    components: { securitySchemes: { accessKey: { type: "http", scheme: "bearer" } } },
    security: [{ accessKey: [] }, {}],
    tags: [
      { name: "read", description: "Any access key." },
      { name: "changes", description: "A full access key, a logged-in browser, or no password." },
    ],
    paths,
  };
}
