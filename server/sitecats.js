// Categories for common sites on the Sites page (UU-C-135). The classifier only knows the
// services it has rules for; everything else lands in "Web services", which makes a category
// filter useless. This list is applied only to such rows (no rule matched), never over a
// category a rule or UniFi gave.
import { registrableDomain } from "./classify.js";

const LIST = {
  "Social networks": [
    "reddit.com", "redd.it", "snapchat.com", "sc-cdn.net", "x.com", "twitter.com", "twimg.com", "pinterest.com", "pinimg.com",
    "discord.com", "discord.gg", "discordapp.com", "discordapp.net", "whatsapp.com", "whatsapp.net", "telegram.org", "tumblr.com",
    "threads.net", "bsky.app", "linkedin.com", "licdn.com", "messenger.com", "quora.com",
  ],
  Gaming: [
    "roblox.com", "rbxcdn.com", "epicgames.com", "fortnite.com", "unrealengine.com", "steampowered.com", "steamcommunity.com",
    "xboxlive.com", "playstation.com", "playstation.net", "minecraft.net", "mojang.com", "ea.com", "riotgames.com",
    "leagueoflegends.com", "blizzard.com", "battle.net", "nintendo.net", "nintendo.com", "supercell.com", "king.com", "miniclip.com",
  ],
  "Ads & tracking": [
    "doubleclick.net", "googlesyndication.com", "googleadservices.com", "app-measurement.com", "google-analytics.com",
    "googletagmanager.com", "scorecardresearch.com", "adnxs.com", "criteo.com", "criteo.net", "taboola.com", "outbrain.com",
    "appsflyer.com", "branch.io", "adjust.com", "amazon-adsystem.com", "adsrvr.org", "rubiconproject.com", "pubmatic.com",
    "moatads.com", "unityads.unity3d.com", "applovin.com", "mopub.com", "chartboost.com", "vungle.com", "inmobi.com",
  ],
  Shopping: ["amazon.com", "ebay.com", "etsy.com", "walmart.com", "target.com", "temu.com", "shein.com", "aliexpress.com", "bestbuy.com", "costco.com", "wayfair.com"],
  "School & learning": [
    "wikipedia.org", "wikimedia.org", "khanacademy.org", "duolingo.com", "quizlet.com", "instructure.com", "schoology.com",
    "kahoot.it", "kahoot.com", "brainly.com", "chegg.com", "coursera.org", "edx.org", "ixl.com", "prodigygame.com", "clever.com",
  ],
  AI: ["openai.com", "chatgpt.com", "oaiusercontent.com", "claude.ai", "anthropic.com", "perplexity.ai", "character.ai", "gemini.google.com", "copilot.microsoft.com", "poe.com", "deepseek.com", "mistral.ai", "grok.com", "x.ai", "meta.ai"],
  News: ["bbc.co.uk", "bbc.com", "cnn.com", "nytimes.com", "foxnews.com", "washingtonpost.com", "theguardian.com", "reuters.com", "apnews.com", "nbcnews.com", "weather.com"],
};

const byDomain = new Map(Object.entries(LIST).flatMap(([cat, list]) => list.map((d) => [d, cat])));

// An app by its name ("ChatGPT" -> chatgpt.com -> AI), for UniFi's vague "TopSites-…" categories
// (UU-C-187). Names are matched to a listed site's first label, whole, ignoring case and spaces.
const byLabel = new Map();
for (const [d, cat] of byDomain) {
  const label = d.split(".")[0];
  if (label.length >= 4 && !byLabel.has(label)) byLabel.set(label, cat);
}
export function appCategory(name) {
  return byLabel.get(String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "")) || null;
}

// "gemini.google.com" is matched whole before its registrable domain.
export function siteCategory(host) {
  const h = String(host || "").toLowerCase();
  return byDomain.get(h) || byDomain.get(registrableDomain(h)) || null;
}
