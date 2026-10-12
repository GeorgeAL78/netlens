// Watched sites (UU-C-135): name connections UniFi recorded only by IP address.
//
// A browser with secure DNS (DNS over HTTPS) asks Google or Cloudflare directly, so the
// gateway never sees the name and UniFi stores a bare IP. Reverse DNS does not help — an
// address names its host company (reflected.net), not the site. So NetLens looks the
// watched sites up itself, every hour, through the same public resolvers those browsers
// use, and remembers which addresses each one answered with. A bare-IP connection to one of
// those addresses is then named "pornhub.com (matched by address)".
//
// Limits, said on the page too: a site behind a shared CDN (Cloudflare) shares its
// addresses with unrelated sites, so such a match is only "possible"; and a site that is
// not on the list is never named this way.
import dns from "node:dns";
import * as db from "./db.js";
import { asnOwnerForIp, registrableDomain } from "./classify.js";
import { logError } from "./log.js";

export const ADULT = "Adult";

// Registrable domains only; "www." and the bare name are both looked up.
const WATCH = {
  [ADULT]: [
    "pornhub.com", "phncdn.com", "youporn.com", "redtube.com", "tube8.com", "brazzers.com",
    "xvideos.com", "xvideos-cdn.com", "xnxx.com", "xnxx-cdn.com", "xhamster.com", "xhcdn.com",
    "chaturbate.com", "highwebmedia.com", "stripchat.com", "bongacams.com", "cam4.com",
    "livejasmin.com", "myfreecams.com", "onlyfans.com", "fansly.com", "spankbang.com",
    "eporner.com", "beeg.com", "txxx.com", "hqporner.com", "motherless.com", "porn.com",
    "youjizz.com", "tnaflix.com", "fapello.com", "erome.com", "thisvid.com", "rule34.xxx",
    "e-hentai.org", "nhentai.net", "hanime.tv",
  ],
};

// Network owners that host nothing but sites of one category: any address of theirs is a
// visit, listed or not. Reflected Networks is Aylo's (Pornhub, YouPorn, RedTube, Brazzers).
const OWNERS = { "reflected.net": { category: ADULT, site: "Aylo sites (Pornhub, YouPorn, RedTube…)" } };

// Address owners whose addresses many unrelated sites share. A match there is "possible".
const SHARED = /^(cloudflare\.com|akamai|fastly\.com|amazon|google\.com|microsoft\.com|cloudfront)/;

const domainCategory = new Map(Object.entries(WATCH).flatMap(([cat, list]) => list.map((d) => [d, cat])));
export const watchedCategories = Object.keys(WATCH).flatMap((c) => [c, `${c} (possible)`]);

// A named host on the list ("ei.phncdn.com" -> Adult), else null.
export function categoryForHost(host) {
  return domainCategory.get(registrableDomain(host)) || null;
}

const RESOLVERS = ["1.1.1.1", "8.8.8.8"];
const HOUR = 3600e3;
const KEEP_MS = 60 * 86400e3;
let running = false;

export async function refresh(now = Date.now(), { force = false } = {}) {
  if (process.env.NETLENS_OFFLINE === "1" || running) return;
  if (!force && now - Number(db.metaGet("watch_refreshed_at") || 0) < HOUR) return;
  running = true;
  try {
    const rows = [];
    for (const server of RESOLVERS) {
      const r = new dns.promises.Resolver({ timeout: 3000, tries: 1 });
      r.setServers([server]);
      for (const [domain, category] of domainCategory) {
        for (const host of [domain, `www.${domain}`]) {
          const ips = await r.resolve4(host).catch(() => []);
          for (const ip of ips) rows.push({ ip, domain, category });
        }
      }
    }
    db.saveWatchIps(rows, now);
    db.pruneWatchIps(now - KEEP_MS);
    db.metaSet("watch_refreshed_at", now);
  } catch (err) {
    logError("watchlist refresh", err);
  } finally {
    running = false;
  }
}

// A matcher over what is stored: (ip, t) -> { site, category, match, confidence } or null.
// An address counts if a watched site used it within a week of the connection.
export function matcher() {
  const byIp = new Map();
  for (const r of db.watchIps()) {
    if (!byIp.has(r.ip)) byIp.set(r.ip, []);
    byIp.get(r.ip).push(r);
  }
  return (ip, t) => {
    const hits = (byIp.get(ip) || []).filter((r) => r.lastSeen >= t - 7 * 86400e3);
    const owner = asnOwnerForIp(ip);
    if (hits.length) {
      const names = [...new Set(hits.map((h) => h.domain))].sort();
      // On a shared CDN the address serves unrelated sites too: its own chip, so a TV that
      // reached a CloudFront edge is not filed as adult.
      const possible = SHARED.test(owner);
      return {
        site: names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(", "),
        category: possible ? `${hits[0].category} (possible)` : hits[0].category,
        match: "address",
        confidence: possible ? "possible" : "likely",
      };
    }
    if (OWNERS[owner]) return { site: OWNERS[owner].site, category: OWNERS[owner].category, match: "network", confidence: "likely" };
    return null;
  };
}
