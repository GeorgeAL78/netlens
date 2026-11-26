// What kind of device each client is (UU-C-293), for the Devices page's icons and groups.
//
// UniFi fingerprints every client and keeps the result on it as numbers: dev_id (the model),
// dev_cat (the type) and dev_family. The console names those numbers in its own table,
// v2 `fingerprint_devices/0` (~0.9 MB, measured on Network 11.0.104): dev_type_ids,
// family_ids and dev_ids {name, dev_type_id, family_id}. It is read at most once a week and
// held in memory; each client's resolved names are saved with the client (clients.fp) so the
// stored device list has them too. The owner's own choice (setting `device_kinds`) wins over
// all of it, and a device UniFi did not fingerprint gets a guess from its name, marked so.
import * as db from "./db.js";
import * as unifi from "./unifi.js";
import { logError } from "./log.js";

const WEEK = 7 * 86400e3;
const DAY = 86400e3;

// The kinds NetLens draws. The page has the same list with labels and icons.
export const KINDS = ["phone", "tablet", "computer", "laptop", "tv", "console", "speaker", "camera", "printer", "watch", "network", "server", "smart", "light", "car", "vm", "other"];

let table = null; // { at, types: {id: name}, families: {id: name}, devs: {id: {n, t, f}} }
let failedAt = 0;
let pending = null;

// The console's table, refreshed weekly; a failure (an older console without it) waits a day.
export async function ensureTable(now = Date.now()) {
  if (table && now - table.at < WEEK) return table;
  if (now - failedAt < DAY) return table;
  if (pending) return pending;
  pending = (async () => {
    try {
      const fp = await unifi.getFingerprints();
      const devs = {};
      for (const [id, d] of Object.entries(fp?.dev_ids || {})) if (d?.name) devs[id] = { n: d.name, t: d.dev_type_id, f: d.family_id };
      table = { at: now, types: fp?.dev_type_ids || {}, families: fp?.family_ids || {}, devs };
    } catch (err) {
      failedAt = now;
      logError("fingerprint: table", err);
    } finally {
      pending = null;
    }
    return table;
  })();
  return pending;
}

// UniFi's names for one client record (rest/user): { type, family, model } or null.
export function namesOf(u) {
  if (!table || !u) return null;
  const dev = u.dev_id != null ? table.devs[String(u.dev_id)] : null;
  const typeId = u.dev_cat ?? dev?.t;
  const famId = u.dev_family ?? dev?.f;
  const out = {
    type: typeId != null ? table.types[String(typeId)] || null : null,
    family: famId != null ? table.families[String(famId)] || null : null,
    model: dev?.n || null,
  };
  return out.type || out.family || out.model ? out : null;
}

// UniFi's type, family and model -> one of KINDS (null when UniFi said nothing useful).
export function kindOfNames(n) {
  if (!n) return null;
  const tf = `${n.type || ""} | ${n.family || ""}`;
  const all = `${tf} | ${n.model || ""}`;
  if (/tablet|ipad/i.test(all)) return "tablet";
  if (/smartphone|phone/i.test(tf) || /iphone|pixel \d|galaxy s/i.test(n.model || "")) return "phone";
  if (/watch|wearable/i.test(tf)) return "watch";
  if (/game console|playstation|xbox|nintendo/i.test(all)) return "console";
  if (/tv|set-top|streaming/i.test(tf)) return "tv";
  if (/speaker/i.test(tf)) return "speaker";
  if (/camera|doorbell/i.test(all)) return "camera";
  if (/printer|scanner/i.test(all)) return "printer";
  if (/laptop|notebook|macbook/i.test(n.model || "")) return "laptop";
  if (/monitor|desktop|laptop|computer/i.test(tf)) return "computer";
  if (/nas|server|storage|operating system|os component|hypervisor/i.test(tf)) return "server";
  if (/access point|router|switch|firewall|gateway|mesh/i.test(tf)) return "network";
  if (/light|bulb/i.test(tf)) return "light";
  if (/car|vehicle|charger|battery/i.test(tf)) return "car";
  if (n.type || n.family) return "smart";
  return null;
}

// A device UniFi did not fingerprint: a guess from the words in its name or host name.
const GUESS = [
  [/iphone|android|pixel|galaxy|oneplus|\bphone\b/i, "phone"],
  [/ipad|tablet|\bfire\b|kindle/i, "tablet"],
  [/macbook|laptop|thinkpad|notebook|surface/i, "laptop"],
  [/\btv\b|smart-?tv|roku|chromecast|apple-?tv|shield|firestick/i, "tv"],
  [/xbox|playstation|\bps[45]\b|nintendo/i, "console"],
  [/echo|homepod|sonos|nest-?(audio|mini)|speaker/i, "speaker"],
  [/cam(era)?\b|doorbell|\bring\b/i, "camera"],
  [/printer|canon|epson|brother/i, "printer"],
  [/watch/i, "watch"],
  [/nas\b|unraid|synology|server|proxmox|truenas/i, "server"],
  [/desktop|\bpc\b|imac|windows|workstation/i, "computer"],
];
// Makers whose chips go almost only into smart-home gadgets (plugs, fans, bulbs).
const SMART_MAKERS = /espressif|tuya|shelly|sonoff|itead|wiz connected|lifx|ecobee|tp-link.*kasa|signify|philips lighting/i;
export function guessKind(...words) {
  const s = words.filter(Boolean).join(" ");
  for (const [re, k] of GUESS) if (re.test(s)) return k;
  return null;
}

// The owner's choices: mac -> kind.
export function overrides() {
  try {
    const v = JSON.parse(db.getSetting("device_kinds", "{}"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
export function setOverride(mac, kind) {
  const o = overrides();
  const m = String(mac).toLowerCase();
  if (!kind) delete o[m];
  else if (KINDS.includes(kind)) o[m] = kind;
  else throw Object.assign(new Error("Unknown device type."), { status: 400 });
  db.setSetting("device_kinds", JSON.stringify(o));
  return o[m] ?? null;
}

// The type shown for one device: { kind, source: you | unifi | guess | virtual, type, model }.
// `names` = UniFi's names (live or stored), `guest` = guests.guestKind(...).
// `hosts` = true when VMs or containers run on it (it is then a server, unless UniFi or the
// owner said otherwise); `vendor` = its maker, for the smart-home guess.
export function typeOf(mac, names, guest, words, choices = overrides(), { hosts = false, vendor = null } = {}) {
  const own = choices[mac];
  const base = { type: names?.type || null, family: names?.family || null, model: names?.model || null };
  if (own) return { kind: own, source: "you", ...base };
  if (guest) return { kind: "vm", source: "virtual", ...base, model: base.model || guest.platform || null };
  const k = kindOfNames(names);
  if (k) return { kind: k, source: "unifi", ...base };
  if (hosts) return { kind: "server", source: "host", ...base };
  const g = guessKind(...words) || (SMART_MAKERS.test(vendor || "") ? "smart" : null);
  return { kind: g || "other", source: g ? "guess" : "none", ...base };
}
