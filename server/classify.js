import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

function hostsFromFlow(flow) {
  const dest = flow.destination || {};
  const raw = [dest.host_name, dest.client_name, dest.id, ...(dest.domains || [])]
    .filter((v) => typeof v === "string" && v.trim())
    .map((v) => v.trim().toLowerCase().replace(/\.$/, ""));
  const hosts = [];
  for (const value of raw) {
    if (value.includes(" ")) continue;
    hosts.push(value);
    if (value.includes("/")) hosts.push(value.split("/")[0]);
  }
  return [...new Set(hosts)];
}

function bytesFromFlow(flow) {
  const td = flow.traffic_data || {};
  const rx = Number(td.bytes_rx || 0);
  const tx = Number(td.bytes_tx || 0);
  return {
    bytes: Number(td.bytes_total ?? rx + tx),
    bytesRx: rx,
    bytesTx: tx,
  };
}

function timeFromFlow(flow) {
  return Number(flow.flow_start_time || flow.time || 0);
}

function endFromFlow(flow) {
  const start = timeFromFlow(flow);
  const end = Number(flow.flow_end_time || 0);
  return end > start ? end : start;
}

const RULES = [
  {
    app: "YouTube",
    category: "Media streaming services",
    kind: "playback",
    suffixes: ["googlevideo.com"],
  },
  {
    app: "YouTube",
    category: "Media streaming services",
    kind: "background",
    suffixes: ["youtube.com", "youtu.be", "ytimg.com", "youtube-nocookie.com", "yt.be", "ggpht.com"],
    includes: ["youtubei.googleapis.", "ytimg.", "ggpht.", "s.youtube."],
  },
  {
    app: "Netflix",
    category: "Media streaming services",
    kind: "playback",
    suffixes: ["nflxvideo.net"],
  },
  {
    app: "Netflix",
    category: "Media streaming services",
    kind: "background",
    suffixes: ["netflix.com", "nflximg.net", "nflxso.net", "nflxext.com"],
  },
  {
    app: "Disney+",
    category: "Media streaming services",
    suffixes: ["disneyplus.com", "dssott.com", "bamgrid.com", "disneystreaming.com"],
  },
  {
    app: "Amazon Video",
    category: "Media streaming services",
    suffixes: ["aiv-cdn.net", "amazonvideo.com", "atv-ps.amazon.com", "media-amazon.com"],
    includes: ["primevideo.", "amazonvideo."],
  },
  {
    app: "Hulu",
    category: "Media streaming services",
    suffixes: ["hulu.com", "hulustream.com", "huluim.com"],
  },
  {
    app: "Twitch",
    category: "Media streaming services",
    suffixes: ["twitch.tv", "ttvnw.net", "jtvnw.net"],
  },
  {
    app: "TikTok",
    category: "Social networks",
    suffixes: ["tiktok.com", "tiktokv.com", "tiktokcdn.com", "musical.ly", "byteoversea.com"],
  },
  {
    app: "Instagram",
    category: "Social networks",
    suffixes: ["instagram.com", "cdninstagram.com"],
  },
  {
    app: "Facebook",
    category: "Social networks",
    suffixes: ["facebook.com", "fbcdn.net", "fb.com", "facebook.net"],
  },
  {
    app: "Spotify",
    category: "Media streaming services",
    suffixes: ["spotify.com", "scdn.co", "spotifycdn.com"],
  },
  {
    app: "iTunes/App Store",
    category: "Media streaming services",
    suffixes: ["itunes.apple.com", "mzstatic.com", "apple-dns.net"],
    includes: ["audio-ssl.itunes.", "video-ssl.itunes."],
  },
  {
    // Apple's download servers. Apple-only, so naming it Apple is evidence, not a guess
    // — but it must NOT fold into iTunes/App Store. It also delivers OS updates: on
    // 2026-09-18 each Apple device pulled ~10 GB from aaplimg.com that UniFi's DPI
    // called "SSL/TLS", with App Store at 0-1 GB. On ordinary days it tracks DPI's App
    // Store figure within ~10%, which is exactly why it is tempting and wrong to merge.
    app: "Apple downloads",
    category: "Software updates",
    suffixes: ["aaplimg.com"],
  },
  {
    app: "Apple.com",
    category: "Web services",
    suffixes: ["apple.com", "icloud.com", "icloud-content.com"],
  },
  {
    app: "Google Play",
    category: "Web services",
    suffixes: ["play.googleapis.com", "play.google.com", "android.clients.google.com"],
    includes: ["android.googleapis."],
  },
  {
    app: "Google APIs",
    category: "Web services",
    suffixes: ["googleapis.com", "gstatic.com", "google.com", "googleusercontent.com", "ggpht.com"],
  },
  {
    app: "Speedtest.net",
    category: "Network protocols",
    suffixes: ["speedtest.net", "ookla.com"],
  },
  {
    app: "Cloudflare",
    category: "Web services",
    suffixes: ["cloudflare.com", "cloudflare-dns.com"],
    includes: ["cloudflared"],
  },
  {
    app: "Akamai CDN",
    category: "Web services",
    suffixes: ["akamai.net", "akamaized.net", "akamaihd.net", "akamaitechnologies.com"],
  },
];

// Bumped whenever classification output changes. cache.js compares it per day file and
// re-annotates in place on restore, so improvements reach already-cached days without
// refetching from UniFi.
export const CLASSIFIER_VERSION = 8;

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6 = /^[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,}$/i;

function isIpLiteral(host) {
  const h = normalizeHost(host);
  return IPV4.test(h) || IPV6.test(String(host));
}

// UniFi frequently puts an IP in destination.host_name while a real domain sits in
// destination.domains. Taking hosts[0] blindly labelled 157k flows "HTTPS" when a name
// was right there.
function bestHost(hosts) {
  return (hosts || []).find((h) => !isIpLiteral(h) && normalizeHost(h).includes(".")) || hosts?.[0] || "";
}

// eTLD+1 via the Public Suffix List (publicsuffix.org, MPL-2.0), vendored at
// server/data/public_suffix_list.dat so nothing is fetched at runtime.
//
// ICANN section only, deliberately. The PRIVATE section lists hosting boundaries such
// as cloudfront.net and github.io; honouring those would make every CloudFront
// distribution its own "service" (d1234.cloudfront.net), fragmenting exactly the
// traffic we are trying to group. Infrastructure is handled separately, by
// isInfrastructureDomain.
const PSL = (() => {
  const rules = new Set();
  const wildcards = new Set();
  const exceptions = new Set();
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const text = fs.readFileSync(path.join(here, "data", "public_suffix_list.dat"), "utf8");
    let inIcann = false;
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line.startsWith("// ===BEGIN ICANN DOMAINS===")) { inIcann = true; continue; }
      if (line.startsWith("// ===END ICANN DOMAINS===")) { inIcann = false; continue; }
      if (!inIcann || !line || line.startsWith("//")) continue;
      if (line.startsWith("!")) exceptions.add(line.slice(1).toLowerCase());
      else if (line.startsWith("*.")) wildcards.add(line.slice(2).toLowerCase());
      else rules.add(line.toLowerCase());
    }
  } catch {
    /* falls back to the simple suffix handling below */
  }
  return { rules, wildcards, exceptions, loaded: rules.size > 0 };
})();

// Kept as a fallback for the case where the vendored list is missing.
const MULTI_SUFFIX = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "co.jp", "com.au", "net.au", "org.au",
  "co.nz", "com.br", "com.mx", "co.in", "co.za", "com.tr", "com.cn",
]);

function publicSuffixOf(host) {
  const labels = host.split(".").filter(Boolean);
  // Walk most-specific first, so the first hit is the longest matching rule.
  for (let i = 0; i < labels.length; i += 1) {
    const rest = labels.slice(i);
    const candidate = rest.join(".");
    if (PSL.exceptions.has(candidate)) return rest.slice(1).join(".");
    if (PSL.rules.has(candidate)) return candidate;
    if (PSL.wildcards.has(labels.slice(i + 1).join("."))) return candidate;
  }
  return labels[labels.length - 1] || "";
}

export function registrableDomain(host) {
  const h = normalizeHost(host).replace(/\.$/, "");
  if (!h || isIpLiteral(h)) return "";
  const labels = h.split(".").filter(Boolean);
  if (labels.length < 2) return "";
  if (!PSL.loaded) {
    const lastTwo = labels.slice(-2).join(".");
    if (labels.length >= 3 && MULTI_SUFFIX.has(lastTwo)) return labels.slice(-3).join(".");
    return lastTwo;
  }
  const suffixLabels = publicSuffixOf(h).split(".").filter(Boolean).length || 1;
  // The host is itself a public suffix (e.g. "co.uk"): there is no registrable domain.
  if (labels.length <= suffixLabels) return "";
  return labels.slice(labels.length - suffixLabels - 1).join(".");
}

function normalizeHost(host) {
  return String(host || "")
    .toLowerCase()
    .replace(/_/g, ".");
}

function hostMatches(host, rule) {
  const h = normalizeHost(host);
  if (rule.prefixes?.some((p) => h.startsWith(p))) return true;
  if (rule.includes?.some((p) => h.includes(p) || String(host).includes(p))) return true;
  if (rule.suffixes?.some((s) => h === s || h.endsWith(`.${s}`) || h.includes(`.${s}`))) return true;
  return false;
}

const MAC_LIKE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i;
const PRIVATE_IPV4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

// A destination on this network rather than on the internet. UniFi writes resolved hosts
// as "<ip>_<name>", so the name is recovered from either half.
export function localHostName(host) {
  const raw = String(host || "").trim();
  if (!raw) return null;
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})[._](.+)$/.exec(raw);
  const ip = m ? m[1] : /^\d{1,3}(?:\.\d{1,3}){3}$/.test(raw) ? raw : null;
  const label = m ? m[2] : ip ? "" : raw;
  const named = label && !label.includes(".") && !MAC_LIKE.test(label) ? label : "";
  if (ip) return PRIVATE_IPV4.test(ip) ? named || "Local network" : null;
  // No IP at all: a bare hostname with no dot is a LAN name ("mediaserver", "nas"), and a
  // MAC is a device UniFi could not name.
  if (MAC_LIKE.test(raw)) return "Local network";
  return named || null;
}

export function classifyFlow(flow) {
  const hosts = hostsFromFlow(flow);
  const service = String(flow.service || "").toLowerCase();
  // Before the rules: LAN traffic never reaches the internet, so no rule can describe it,
  // and it used to fall through to "Unidentified" — which the App picker hides, leaving a
  // home media server's streaming invisible everywhere in the app (UU-F-051).
  for (const host of hosts) {
    const local = localHostName(host);
    if (local) {
      return {
        app: local,
        category: "Local network",
        domain: host,
        confidence: local === "Local network" ? "low" : "high",
        source: "local",
      };
    }
  }
  for (const host of hosts) {
    for (const rule of RULES) {
      if (hostMatches(host, rule)) {
        return {
          app: rule.app,
          category: rule.category,
          domain: host,
          kind: rule.kind || "generic",
          confidence: rule.kind === "background" ? "low" : "high",
        };
      }
    }
  }
  if (service === "dns") {
    return { app: "DNS", category: "Network protocols", domain: bestHost(hosts) || "dns", confidence: "medium" };
  }
  // No rule matched. Name the flow by its registrable domain rather than the useless
  // label "HTTPS" — steampowered.com and real-debrid.com tell the owner something.
  // `source: "domain"` marks it as inferred, so the UI can distinguish it from a
  // rule-matched name.
  const host = bestHost(hosts);
  const reg = registrableDomain(host);
  if (reg) {
    return { app: reg, category: "Web services", domain: host, confidence: "low", source: "domain" };
  }
  if (host) {
    return { app: "Unidentified", category: "Unknown", domain: host, confidence: "low" };
  }
  return { app: "Unidentified", category: "Unknown", domain: "unknown", confidence: "low" };
}

// Re-derive app/category from a row that is already annotated and has lost its original
// host candidates. Used by the on-restore upgrade: it recovers the domain-based naming
// for rows whose stored `domain` is a hostname, but cannot help bare-IP rows.
export function reclassifyCachedRow(row) {
  if (!row || !row.domain || row.domain === "unknown") return row;
  const fresh = classifyFlow({ destination: { host_name: row.domain }, service: row.service });
  return { ...row, app: fresh.app, category: fresh.category, kind: fresh.kind, confidence: fresh.confidence, source: fresh.source };
}

export function annotateFlow(flow) {
  const classified = classifyFlow(flow);
  const parts = bytesFromFlow(flow);
  return {
    ...classified,
    t: timeFromFlow(flow),
    tEnd: endFromFlow(flow),
    bytes: parts.bytes,
    bytesRx: parts.bytesRx,
    bytesTx: parts.bytesTx,
    service: flow.service || "",
    action: flow.action || "",
    mac: String(flow.source?.mac || "").toLowerCase(),
  };
}

const PLAYBACK_FLOW_MIN = 8 * 1024 * 1024;
export const SESSION_GAP_MS = 4 * 60 * 1000;
export const SESSION_MIN_BYTES = 40 * 1024 * 1024;
const PLAYBACK_HOST_MARKERS = ["googlevideo.com", "nflxvideo.net"];
const BACKGROUND_HOST_MARKERS = [
  "ytimg.",
  "ggpht.",
  "s.youtube.",
  "youtubei.googleapis.",
  "youtube-nocookie.",
  "nflximg.",
  "nflxso.",
  "nflxext.",
];

export function isBackgroundVideoHost(domain) {
  const h = normalizeHost(domain);
  if (BACKGROUND_HOST_MARKERS.some((m) => h.includes(m))) return true;
  if (h.includes("youtube.com") && !h.includes("googlevideo.com")) return true;
  if (h.includes("netflix.com") && !h.includes("nflxvideo.net")) return true;
  return false;
}

export function isPlaybackFlow(row, minBytes = PLAYBACK_FLOW_MIN) {
  if (!row) return false;
  if (Number(row.bytes) < minBytes) return false;
  if (row.kind === "background" || isBackgroundVideoHost(row.domain)) return false;
  const h = normalizeHost(row.domain);
  // A known video CDN is a definite yes. Everything else that clears the size floor and
  // is not a known background host counts too: the markers only covered googlevideo and
  // nflxvideo, so selecting Crunchyroll (or Disney+, or anything without a rule) drew an
  // empty chart and an empty session list despite real traffic. The background
  // exclusions and the 8 MB / 40 MB floors still do the filtering that REVIEW rule 1
  // cares about — thumbnails, API chatter and overnight drips remain excluded.
  if (PLAYBACK_HOST_MARKERS.some((m) => h.includes(m))) return true;
  if (row.kind === "playback") return true;
  return row.app !== "DNS" && row.app !== "Local network";
}

// Groups flows into sessions. `significantPlaybackFlows` is expressed in terms of this
// with its original thresholds, so playback behaviour (REVIEW rule 1) is unchanged.
//
// keyBy decides what counts as "the same activity": playback clusters per device only,
// the general activity list clusters per device *and* app so two services running at
// once do not merge into one meaningless row.
export function sessionize(rows, { gapMs, minBytes, keyBy = "mac+app" } = {}) {
  const sorted = (rows || []).filter((r) => r && r.t).sort((a, b) => a.t - b.t);
  const groups = new Map();
  for (const row of sorted) {
    const key = keyBy === "mac" ? row.mac || "unknown" : `${row.mac || "unknown"}||${row.app || "?"}`;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }

  const sessions = [];
  for (const list of groups.values()) {
    let current = [];
    const flush = () => {
      if (!current.length) return;
      const bytes = current.reduce((n, r) => n + Number(r.bytes || 0), 0);
      if (bytes >= minBytes) {
        const byDomain = new Map();
        for (const r of current) byDomain.set(r.domain, (byDomain.get(r.domain) || 0) + Number(r.bytes || 0));
        const first = current[0];
        const last = current[current.length - 1];
        // A session ends when its last flow ends. Using the last flow's *start* made a
        // one-flow session zero-length regardless of how long it actually ran.
        const endsAt = current.reduce((n, r) => Math.max(n, Number(r.tEnd || r.t || 0)), 0);
        sessions.push({
          app: first.app,
          category: first.category,
          mac: first.mac,
          start: first.t,
          end: Math.max(endsAt, last.t),
          durationMs: Math.max(0, Math.max(endsAt, last.t) - first.t),
          bytes,
          bytesRx: current.reduce((n, r) => n + Number(r.bytesRx || 0), 0),
          bytesTx: current.reduce((n, r) => n + Number(r.bytesTx || 0), 0),
          flowCount: current.length,
          domains: [...byDomain.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([d]) => d),
          source: first.source,
          rows: current,
        });
      }
      current = [];
    };
    // Split on idle time — from the end of everything so far to the next start — not on
    // start-to-start distance. With hourly history rows, start-to-start is always an hour,
    // so every hour became its own session; a long flow also kept a session "busy" only
    // until the next row's start under the old rule.
    let lastEnd = 0;
    for (const row of list) {
      if (current.length && row.t - lastEnd > gapMs) {
        flush();
        lastEnd = 0;
      }
      current.push(row);
      lastEnd = Math.max(lastEnd, Number(row.tEnd || row.t || 0));
    }
    flush();
  }
  return sessions.sort((a, b) => b.start - a.start);
}

// The playback sessions themselves. The Apps table needs their bytes and durations to
// report the same basis the session list under it shows, so the thresholds live here
// once and both callers read them from the same place.
export function playbackSessions(rows) {
  const playback = (rows || []).filter((row) => isPlaybackFlow(row));
  return sessionize(playback, {
    gapMs: SESSION_GAP_MS,
    minBytes: SESSION_MIN_BYTES,
    keyBy: "mac",
  });
}

export function significantPlaybackFlows(rows) {
  const kept = [];
  for (const session of playbackSessions(rows)) {
    // Loop rather than spread: a long session can exceed V8's argument limit.
    for (const row of session.rows) kept.push(row);
  }
  return kept;
}

// Sessions for the general activity list: a wider gap than playback, and a small floor
// so idle chatter does not fill the table.
export const ACTIVITY_GAP_MS = 10 * 60 * 1000;
export const ACTIVITY_MIN_BYTES = 1024 * 1024;

// Multi-tenant CDNs and carrier infrastructure. These front many unrelated services, so
// traffic to them cannot be attributed to any one of them from the hostname: Crunchyroll
// rides Fastly, but so does a great deal else. They are worth showing — it is real
// traffic — but they must not be presented as if they were a service.
const INFRASTRUCTURE_DOMAINS = new Set([
  "fastly.net", "cloudfront.net", "akamai.net", "akamaiedge.net", "akamaitechnologies.com",
  "akadns.net", "edgekey.net", "edgesuite.net", "llnwd.net", "cdn77.org", "cachefly.net",
  "azureedge.net", "msedge.net", "spov-msedge.net", "gcdn.co", "globalcdn.co",
  "ovscdns.net", "amazonaws.com", "gvt1.com", "a2z.com", "1e100.net",
]);

export function isInfrastructureDomain(name) {
  const h = normalizeHost(name);
  if (INFRASTRUCTURE_DOMAINS.has(h)) return true;
  return [...INFRASTRUCTURE_DOMAINS].some((d) => h.endsWith(`.${d}`));
}

// Would this detected domain be the same service as a DPI application? Deliberately
// narrow: exact match, or the brand plus a content-delivery word, so crunchyrollcdn.com
// folds into Crunchyroll while amazonaws.com does NOT get swallowed by Amazon.
const CDN_WORDS = ["cdn", "cdns", "static", "img", "images", "media", "video", "stream", "assets", "edge"];

export function domainFoldsIntoApp(domain, dpiName) {
  const label = String(domain || "").toLowerCase().replace(/\.[a-z.]+$/, "").replace(/[^a-z0-9]/g, "");
  const app = String(dpiName || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!label || !app) return false;
  if (label === app) return true;
  return CDN_WORDS.some((w) => label === app + w || label === w + app);
}

// Name bare-IP flows from UniFi's own resolutions elsewhere in the same day.
//
// UniFi writes a resolved destination as "<ip>_<hostname>", so a day's flows contain a
// free IP-to-hostname table for every host it managed to resolve. A flow that carries
// only an IP can borrow that name — this is evidence (the console resolved that exact
// address), not the timing inference that was measured and rejected in UU-C-033.
//
// Two deliberate constraints:
//   * per day only. Addresses are reassigned, and a name borrowed from last week is a
//     guess dressed up as a fact.
//   * unambiguous only. An IP that resolved to several different names in the same day
//     is shared hosting or a CDN edge; naming it after one of them would be wrong.
const IPV4_ONLY = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const IP_PREFIXED = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})[._](.+)$/;
const NAMEABLE = new Set(["Unidentified", "HTTPS"]);

// IP -> network operator, from the vendored IPinfo Lite snapshot (CC BY-SA 4.0, see
// server/data/README.md). Loaded lazily and only once: it is 4 MB gzipped and nothing
// needs it until flows are actually being classified.
//
// This names the *operator that owns the address*, not the service using it. Traffic to
// a Fastly address resolves to fastly.com whoever is behind it, so these rows are marked
// `source: "asn"` and the UI says so. It is the weakest of the three naming signals and
// is only ever applied to flows nothing better could name.
let asnDb = null;

function loadAsnDb() {
  if (asnDb) return asnDb;
  asnDb = { starts: new Uint32Array(0), ends: new Uint32Array(0), labels: [], size: 0 };
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const text = zlib.gunzipSync(fs.readFileSync(path.join(here, "data", "ip2asn.tsv.gz"))).toString("utf8");
    const lines = text.split("\n");
    const starts = new Uint32Array(lines.length);
    const ends = new Uint32Array(lines.length);
    const labels = new Array(lines.length);
    let n = 0;
    for (const line of lines) {
      if (!line) continue;
      const a = line.indexOf("\t");
      const b = line.indexOf("\t", a + 1);
      if (a < 0 || b < 0) continue;
      starts[n] = Number(line.slice(0, a));
      ends[n] = Number(line.slice(a + 1, b));
      labels[n] = line.slice(b + 1);
      n += 1;
    }
    asnDb = { starts: starts.subarray(0, n), ends: ends.subarray(0, n), labels, size: n };
  } catch {
    /* absent or unreadable: ASN naming simply does not happen */
  }
  return asnDb;
}

function ipToInt(ip) {
  const p = ip.split(".");
  if (p.length !== 4) return -1;
  let v = 0;
  for (const part of p) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return -1;
    v = v * 256 + n;
  }
  return v;
}

export function asnOwnerForIp(ip) {
  const v = ipToInt(String(ip || ""));
  if (v < 0) return "";
  const db = loadAsnDb();
  if (!db.size) return "";
  let lo = 0;
  let hi = db.size - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (v < db.starts[mid]) hi = mid - 1;
    else if (v > db.ends[mid]) lo = mid + 1;
    else return db.labels[mid];
  }
  return "";
}

export function buildIpNameMap(rows) {
  const candidates = new Map();
  for (const r of rows || []) {
    const m = String(r.domain || "").match(IP_PREFIXED);
    if (!m || IPV4_ONLY.test(m[2])) continue;
    const reg = registrableDomain(m[2]);
    if (!reg) continue;
    if (!candidates.has(m[1])) candidates.set(m[1], new Set());
    candidates.get(m[1]).add(reg);
  }
  const map = new Map();
  for (const [ip, names] of candidates) if (names.size === 1) map.set(ip, [...names][0]);
  return map;
}

// Returns a new array; rows that gain a name are replaced, the rest are passed through.
export function nameBareIpFlows(rows) {
  const map = buildIpNameMap(rows);
  return (rows || []).map((r) => {
    // A name borrowed on an earlier delta is re-derived, not kept: if the address has
    // since resolved to several hostnames it is ambiguous and must lose the name again.
    // Without this the pass is not idempotent and an accumulating day keeps a stale
    // label that a full refetch would not produce (UU-F-034).
    const borrowed = r.source === "ip" || r.source === "asn";
    const base = borrowed
      ? { ...r, app: "Unidentified", category: "Unknown", domain: r.ip || r.domain, source: undefined, ip: undefined }
      : r;
    if (!NAMEABLE.has(base.app)) return base === r ? r : base;
    const ip = String(base.domain || "");
    // Strongest first: another flow in this same day where UniFi resolved this address.
    const sameDay = map.get(ip);
    if (sameDay) {
      return {
        ...base,
        app: sameDay,
        category: "Web services",
        confidence: "low",
        // The borrowed hostname becomes the domain, with the address kept alongside.
        // isPlaybackFlow and isBackgroundVideoHost key off `domain`, so leaving the raw
        // IP there let an 8 MB ytimg flow reached by address count as playback
        // (UU-F-036).
        domain: sameDay,
        ip,
        // Distinct from "domain": this name came from another flow, not from this one.
        source: "ip",
      };
    }
    // Weakest: whoever owns the address block. An operator, not a service, so the
    // address stays in `domain` — we do not know the host, only who runs the network.
    const owner = asnOwnerForIp(ip);
    if (!owner) return base === r ? r : base;
    return { ...base, app: owner, category: "Web services", confidence: "low", ip, source: "asn" };
  });
}

// Does a classified flow belong to a DPI application? Exact name, or the narrow CDN
// fold. Deliberately NOT namesMatchApp's substring test: that pulled amazonaws.com into
// Amazon, contradicting the fold rule the App picker already applies (UU-F-035).
export function appMatchesFlow(classifiedApp, dpiName) {
  const a = String(classifiedApp || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const b = String(dpiName || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!a || !b) return false;
  if (a === b) return true;
  return domainFoldsIntoApp(classifiedApp, dpiName);
}

export function namesMatchApp(classifiedApp, dpiName) {
  const a = String(classifiedApp || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const b = String(dpiName || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}
