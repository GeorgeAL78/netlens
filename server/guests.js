// Virtual machines and containers under the device that runs them (UU-C-165).
//
// A home server (Unraid, Proxmox, a NAS) gives each container on a custom network and each VM
// its own MAC address, so UniFi lists them as separate devices on the server's switch port.
// NetLens folds them under their host on the Network map, with strict rules so that real
// devices are never put "inside" another:
//   1. only addresses that look virtual are ever moved: a hypervisor's MAC prefix or vendor
//      (VMware, Proxmox, KVM/QEMU, Hyper-V, VirtualBox, Parallels, Xen), or a wired, locally
//      administered (made-up) MAC — what Docker / macvlan containers get;
//   2. on a port, only when exactly ONE physical device shares it (a desk switch with a PC and
//      a printer has two, so nothing is grouped);
//   3. a VM UniFi cannot place on a port is put under the device it goes offline together with
//      (14 days of presence history) — marked "probably", never as fact;
//   4. the owner's choice on the device page ("Runs on …", or "not a guest") wins over all of it,
//      and grouping can be turned off in Settings.
import * as db from "./db.js";

const VM_PREFIXES = {
  "00:0c:29": "VMware",
  "00:50:56": "VMware",
  "00:05:69": "VMware",
  "00:1c:14": "VMware",
  "bc:24:11": "Proxmox",
  "52:54:00": "KVM / QEMU",
  "00:15:5d": "Hyper-V",
  "08:00:27": "VirtualBox",
  "0a:00:27": "VirtualBox",
  "00:1c:42": "Parallels",
  "00:16:3e": "Xen",
};
const VM_VENDOR = /vmware|virtualbox|parallels|qemu|xensource|proxmox/i;

// { kind: "vm" | "container", platform } or null for a physical device.
export function guestKind(mac, vendor, wired) {
  const m = String(mac || "").toLowerCase();
  const prefix = m.slice(0, 8);
  if (VM_PREFIXES[prefix]) return { kind: "vm", platform: VM_PREFIXES[prefix] };
  if (VM_VENDOR.test(vendor || "")) return { kind: "vm", platform: String(vendor).replace(/,? ?inc\.?$/i, "") };
  // Phones use made-up MACs on Wi-Fi too; only wired ones count as containers.
  if (wired && (parseInt(m.slice(0, 2), 16) & 2) === 2) return { kind: "container", platform: null };
  return null;
}

// The owner's choices: guest MAC -> host MAC, or "none" (never group this one).
export function overrides() {
  try {
    return JSON.parse(db.getSetting("guest_hosts", "{}")) || {};
  } catch {
    return {};
  }
}

export function setOverride(guest, host) {
  const o = overrides();
  const g = String(guest).toLowerCase();
  if (host == null || host === "") delete o[g];
  else o[g] = host === "none" ? "none" : String(host).toLowerCase();
  db.setSetting("guest_hosts", JSON.stringify(o));
  return o[g] ?? null;
}

export const groupingOn = () => db.getSetting("group_guests", "1") !== "0";

// The physical device a guest goes offline together with: at least 3 offline moments in 14
// days, 80 % of them within 15 minutes of the host going offline, and most of the host's own
// offline moments matched too (a host that is always off would match anything).
export function probableHost(guestMac, candidates, now = Date.now()) {
  const since = now - 14 * 86400e3;
  const offs = (mac) => db.presenceLog(mac, since).filter((r) => r.state === "off").map((r) => r.ts);
  const g = offs(guestMac);
  if (g.length < 3) return null;
  const near = (list, t) => list.some((x) => Math.abs(x - t) <= 15 * 60e3);
  let best = null;
  for (const h of candidates) {
    if (h === guestMac) continue;
    const ho = offs(h);
    if (ho.length < 3) continue;
    const share = g.filter((t) => near(ho, t)).length / g.length;
    const back = ho.filter((t) => near(g, t)).length / ho.length;
    if (share >= 0.8 && back >= 0.6 && (!best || share > best.share)) best = { mac: h, share, times: g.length };
  }
  return best;
}

// Rearranges the Network map in place: nodes (gateway, switches, APs) with .clients, and the
// loose clients UniFi could not place. Every client gets .kind / .platform / .guests.
export function groupGuests(nodes, loose, vendors, now = Date.now()) {
  const all = [...nodes.flatMap((n) => n.clients), ...loose];
  for (const c of all) {
    const g = guestKind(c.mac, vendors.get(c.mac), c.wired);
    c.kind = g?.kind || null;
    c.platform = g?.platform || null;
    c.guests = [];
  }
  if (!groupingOn()) return;
  const o = overrides();
  const byMac = new Map(all.map((c) => [c.mac, c]));
  const detach = (c) => {
    for (const n of nodes) n.clients = n.clients.filter((x) => x !== c);
    const i = loose.indexOf(c);
    if (i >= 0) loose.splice(i, 1);
  };
  const attach = (guest, host, how, note = null) => {
    detach(guest);
    host.guests.push({ ...guest, how, note });
  };
  // 4. The owner's choices first.
  for (const [g, h] of Object.entries(o)) {
    if (h === "none") continue;
    const guest = byMac.get(g);
    const host = byMac.get(h);
    if (guest && host && guest !== host) attach(guest, host, "confirmed");
  }
  const grouped = new Set(all.flatMap((c) => c.guests.map((x) => x.mac)));
  const free = (c) => c.kind && !grouped.has(c.mac) && o[c.mac] !== "none";
  // 1 + 2. One physical device on a port, the rest virtual.
  for (const n of nodes) {
    const ports = new Map();
    for (const c of n.clients) {
      if (!c.wired || c.port == null) continue;
      if (!ports.has(c.port)) ports.set(c.port, []);
      ports.get(c.port).push(c);
    }
    for (const list of ports.values()) {
      const physical = list.filter((c) => !c.kind);
      const virtual = list.filter(free);
      if (physical.length !== 1 || !virtual.length) continue;
      for (const v of virtual) {
        attach(v, physical[0], "port");
        grouped.add(v.mac);
      }
    }
  }
  // 3. VMs UniFi could not place: the device they go offline together with.
  const hosts = nodes.flatMap((n) => n.clients).filter((c) => c.wired && !c.kind);
  for (const v of loose.filter((c) => free(c) && c.kind === "vm")) {
    const p = probableHost(v.mac, hosts.map((h) => h.mac), now);
    const host = p && hosts.find((h) => h.mac === p.mac);
    if (host) attach(v, host, "presence", `goes offline when ${host.name} does (${Math.round(p.share * 100)}% of ${p.times} times)`);
  }
  for (const c of all) c.guests.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}
