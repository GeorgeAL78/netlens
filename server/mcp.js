// MCP endpoint (UU-C-227): POST /mcp, the Model Context Protocol's Streamable HTTP transport,
// answered as plain JSON (no event stream, no sessions). An assistant adds NetLens as a
// connector with the URL http://<host>:3780/mcp and, when a login password is set, the header
// Authorization: Bearer <access key>.
//
// Each tool is one route from server/apispec.js, called over loopback with the caller's own
// credentials, so a tool goes through exactly the checks, answer cache and worker threads the
// web UI does: an MCP call can never do more than the same key could do on /api directly.

import { TOOLS, inputSchema, requestOf } from "./apispec.js";

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
// A tool answer goes into the assistant's context; a 90-day report can be several MB.
const MAX_TEXT = 200_000;

const INSTRUCTIONS = [
  "NetLens is a dashboard for one UniFi network. It stores traffic per device and app, device presence, Wi-Fi quality, switch and access point health, and blocked traffic, for up to 90 days.",
  "Start with get_overview for what needs attention, list_devices for names and MAC addresses, get_usage for who used what, get_network_map for the equipment.",
  "Times are epoch milliseconds; days are YYYY-MM-DD in the network's timezone. Tools that change something are marked; a read-only access key cannot use them.",
].join(" ");

const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

function toolList(canWrite) {
  return TOOLS.filter((t) => canWrite || !t.write).map((t) => ({
    name: t.name,
    title: t.name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()),
    description: t.summary,
    inputSchema: inputSchema(t),
    annotations: { readOnlyHint: !t.write, destructiveHint: Boolean(t.destructive), idempotentHint: t.method !== "POST" || t.name === "rename_device" || t.name === "set_device_host", openWorldHint: false },
  }));
}

// The address this request came in on: always reachable from here, whatever UNIFI_BIND says.
function selfBase(req) {
  let host = String(req.socket.localAddress || "127.0.0.1").replace(/^::ffff:/, "");
  if (host === "::" || host === "0.0.0.0") host = "127.0.0.1";
  if (host.includes(":")) host = `[${host}]`;
  return `http://${host}:${req.socket.localPort}`;
}

async function callTool(req, tool, args) {
  let r;
  try {
    r = requestOf(tool, args || {});
  } catch (err) {
    return { content: [{ type: "text", text: err.message }], isError: true };
  }
  const headers = { accept: "application/json" };
  if (req.headers.authorization) headers.authorization = req.headers.authorization;
  if (req.headers.cookie) headers.cookie = req.headers.cookie;
  if (r.body) headers["content-type"] = "application/json";
  const res = await fetch(selfBase(req) + r.url, { method: r.method, headers, body: r.body ? JSON.stringify(r.body) : undefined });
  let text = await res.text();
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}\n… cut at ${MAX_TEXT} characters of ${text.length}: narrow the request (a shorter period, one device).`;
  if (!res.ok) {
    let msg = text;
    try {
      msg = JSON.parse(text).error || text;
    } catch {}
    return { content: [{ type: "text", text: `HTTP ${res.status}: ${msg}` }], isError: true };
  }
  return { content: [{ type: "text", text }] };
}

async function handle(req, msg, ctx) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpcError(msg?.id, -32600, "Invalid request");
  const isNote = msg.id === undefined || msg.id === null;
  const { id, method, params = {} } = msg;
  if (isNote) return null; // notifications/initialized, notifications/cancelled: nothing to say
  switch (method) {
    case "initialize": {
      const want = String(params.protocolVersion || "");
      return rpcResult(id, {
        protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "netlens", title: "NetLens", version: ctx.version || "dev" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: toolList(ctx.canWrite) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${params.name}`);
      if (tool.write && !ctx.canWrite) return rpcResult(id, { content: [{ type: "text", text: "This access key can only read. Make a full key in NetLens › Settings › API and AI access to allow changes." }], isError: true });
      try {
        return rpcResult(id, await callTool(req, tool, params.arguments));
      } catch (err) {
        return rpcResult(id, { content: [{ type: "text", text: `NetLens could not answer: ${err.message}` }], isError: true });
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

// ctx: { canWrite, version }
export async function mcpPost(req, res, ctx) {
  const body = req.body;
  if (body == null || (typeof body === "object" && !Array.isArray(body) && !Object.keys(body).length && !req.is("application/json"))) {
    return res.status(400).json(rpcError(null, -32700, "Send JSON-RPC as application/json"));
  }
  const batch = Array.isArray(body);
  const out = (await Promise.all((batch ? body : [body]).map((m) => handle(req, m, ctx)))).filter(Boolean);
  if (!out.length) return res.status(202).end();
  res.json(batch ? out : out[0]);
}
