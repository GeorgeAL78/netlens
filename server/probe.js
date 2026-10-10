// Is a device up on the network, whatever UniFi or the internet say? (UU-C-122)
//
// A ping first; many devices drop pings, so then a few common TCP ports. Any answer — an
// accepted connection or a refusal — means the device is there. Only private (LAN) addresses
// are ever probed, and only one device's own address at a time.
import net from "node:net";
import { execFile } from "node:child_process";
import fs from "node:fs";

const PRIVATE = /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/;
export const isPrivateIp = (ip) => PRIVATE.test(String(ip || ""));

// Web, SSH, SMB, alt-web, iPhone/iPad sync, AirPlay, Chromecast, cameras (RTSP), MQTT,
// NAS, printers, UPnP / smart-home hubs.
const PORTS = [80, 443, 22, 445, 8080, 8443, 62078, 7000, 8009, 554, 1883, 5000, 9100, 49152];

function ping(ip) {
  const win = process.platform === "win32";
  const args = win ? ["-n", "1", "-w", "1000", ip] : ["-c", "1", "-W", "1", ip];
  return new Promise((resolve) => {
    execFile("ping", args, { timeout: 3000 }, (err, stdout) => {
      const m = /time[=<]\s*([\d.]+)\s*ms/i.exec(String(stdout || ""));
      // No ping binary or no permission: unknown, not "down".
      if (err && (err.code === "ENOENT" || /permission|not permitted/i.test(String(err.message)))) return resolve({ ok: null });
      resolve({ ok: !err && Boolean(m) && !/unreachable/i.test(stdout), ms: m ? Math.round(Number(m[1])) : null });
    });
  });
}

function knock(ip, port, timeout = 1200) {
  return new Promise((resolve) => {
    const started = Date.now();
    const s = net.connect({ host: ip, port });
    const done = (answer) => {
      s.destroy();
      resolve({ port, answer, ms: Date.now() - started });
    };
    s.setTimeout(timeout, () => done(null));
    s.once("connect", () => done("open"));
    s.once("error", (e) => done(e.code === "ECONNREFUSED" ? "refused" : null));
  });
}

export async function probe(ip) {
  if (!isPrivateIp(ip)) throw new Error("Only addresses on your own network are checked.");
  const p = await ping(ip);
  if (p.ok) return { up: true, method: "ping", ms: p.ms };
  const knocks = await Promise.all(PORTS.map((port) => knock(ip, port)));
  const hit = knocks.filter((k) => k.answer).sort((a, b) => a.ms - b.ms)[0];
  if (hit) return { up: true, method: hit.answer === "open" ? `port ${hit.port}` : `port ${hit.port} (refused, but it answered)`, ms: hit.ms };
  return { up: false, method: p.ok === null ? "ports" : "ping and ports", ms: null };
}

// The MAC that answered at an address (UU-C-124), from the kernel's neighbour table. Only
// works when NetLens sits on the LAN itself (host network, or its own address on br0 /
// macvlan, as on Unraid); in a Docker bridge network LAN MACs are not visible, so null.
export function arpMac(ip) {
  try {
    for (const line of fs.readFileSync("/proc/net/arp", "utf8").split("\n").slice(1)) {
      const [addr, , flags, mac] = line.trim().split(/\s+/);
      if (addr === ip && flags !== "0x0" && mac && !/^(0{2}:){5}0{2}$/.test(mac)) return mac.toLowerCase(); // skip incomplete (all-zero) entries
    }
  } catch {
    /* not Linux, or no access */
  }
  return null;
}

// probe() plus "is it the right device?" — the answering MAC against the expected one, or,
// where MACs cannot be seen, whether UniFi has the address on another device right now.
export async function probeDevice(ip, mac, { ipOwner } = {}) {
  const owner = ipOwner?.get(ip);
  if (owner && owner !== mac) return { up: false, method: "address now used by another device", verify: "mismatch", seenMac: owner };
  const r = await probe(ip);
  if (!r.up) return { ...r, verify: null };
  const seen = arpMac(ip);
  if (seen) return { ...r, verify: seen === mac ? "match" : "mismatch", seenMac: seen, up: seen === mac };
  return { ...r, verify: "unknown" };
}
