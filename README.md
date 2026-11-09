<p align="center"><img src="assets/icon.png" width="96" alt="NetLens icon"></p>

# NetLens

**A dashboard for UniFi networks.**

Self-hosted, it shows **who used how much, of what, and when**,
how good each device's **Wi-Fi** is, how your **access points, switches and gateway** are doing,
and what your firewall and intrusion prevention **blocked** — and it keeps that history,
which UniFi itself deletes after a day or a week.

> Not affiliated with, endorsed by, or sponsored by Ubiquiti Inc. UniFi is a trademark of Ubiquiti Inc.

## Screenshots

| | |
| --- | --- |
| ![Overview — findings and the internet line](assets/screenshots/home.png) | ![Day — every device by hour](assets/screenshots/day.png) |
| **Overview** — findings in plain language, limits on top | **Activity › Timeline** — every device by hour |
| ![Usage — apps, categories and top apps](assets/screenshots/usage.png) | ![Device — traffic, signal and events](assets/screenshots/device.png) |
| **Activity › Apps** — top apps, search by app, category or device | **Device** — its day, apps, sessions and events |
| ![Network — live map with access-point detail](assets/screenshots/network.png) | ![Protection — blocks and intrusions with filters](assets/screenshots/security.png) |
| **Network** — a card per gateway, switch and access point: ports, devices by band and signal, problems counted; access point selected | **Protection** — every block as one incident, with filters; ads and trackers on their own tab |
| ![Devices — new devices, maker and where they connect](assets/screenshots/devices.png) | ![Alerts — daily limits per app and device](assets/screenshots/alerts.png) |
| **Devices** — new devices, maker, switch port or access point, rename | **Limits** — daily limits per app and device |
| ![Sites — every site each device connected to, by category](assets/screenshots/sites.png) | |
| **Activity › Sites** — every site each device connected to, filtered by category | |

<sub>Screenshots use a made-up demo network, not real data.</sub>

## Features

- **Overview** — what happened today, in plain language: the day's big transfers, devices on weak
  Wi-Fi or slow wired links, failed Wi-Fi joins, blocked intrusions and firewall hits, new
  devices, equipment problems, a changed public IP — each linking to the details. Right now:
  provider, public IP, % up and how much of the line is in use.
- **Activity › Timeline** — every device as a row, the day's hours as columns: when each device was busy, when it
  roamed or reconnected, when something was blocked. Click any hour to see it in 5-minute steps.
- **Network** — the internet line, then a card per gateway, switch and access point, from the
  gateway outward: switch ports as tiles with the devices on each port, Wi-Fi devices by band
  with their signal, problems counted on each card. Virtual machines and containers fold under
  the server that runs them; a device the switch lost track of stays at its last known port (↺).
  Pick any time in the last 90 days to see the network as it was then; **History** shows
  internet speed, latency, devices online and every restart or change. Click the internet line
  for its public-IP history, an access point for its radios, a switch for its ports.
- **Device** — per device: traffic, Wi-Fi signal or wired link speed, apps, sessions, events,
  connection time, online history, CSV export, block / unblock.
- **Devices** — every device UniFi knows, new ones first: maker, where it connected (switch port
  or access point and band), IP, first and last seen; rename it (saved in UniFi). Offline devices
  are checked on the network every 5 minutes (ping, then common ports, with a MAC check), so a
  device that is on but not using the internet still shows as there. Blocked devices are listed
  on top, with an Unblock button, and every device has Block / Unblock. Failed Wi-Fi joins
  (couldn't log in, no IP address, DNS failed…) are listed per device with the usual cause,
  kept 90 days.
- **Activity › Sites** — every site each device connected to over the last 90 days, with a filter per
  category (social, gaming, school, ads and tracking, AI, adult…), search, and the times of
  each connection. Taken from UniFi's connection records, not a DNS log (UniFi has none). When a
  browser's secure DNS hides the name, NetLens names the address if it belongs to a watched
  site, from its own hourly lookups.
- **Limits** (the bell in the top bar) — daily limits on time in use or data for an app or category on a device, e.g.
  YouTube on the kids' tablet over 2 hours. Flagged on Overview; watch only.
- **Protection** — every block as one incident: intrusions (IPS signature, both ends, traffic)
  and devices stopped by your firewall rules or app blocks, with the rule's name, merged with
  UniFi's log entry; filters by type, device, site and rule; investigate an outside address;
  ads and trackers on their own tab.
- **Activity › Apps** — apps, categories and devices for a day, an hour or up to 90 days; one search box
  for an app, category or device, and the top apps one click away. **Every number on
  a screen comes from one source and adds up**; a built-in audit (`npm run audit`) checks every
  day × device × app combination.
- **Local-network traffic** (a media server, a NAS) shown separately — UniFi's counters only
  cover internet traffic.
- **Missing data is marked, never shown as a quiet hour**, and filled from UniFi's daily
  per-device totals where those still exist.
- **History export / import**, an optional syslog listener for ad-block counts.
- **API and AI access** — an MCP endpoint (`/mcp`) so Claude or another assistant can ask about
  your network and make safe changes, and the same operations as a REST API described at
  `/api/openapi.json`. See [API and AI access](#api-and-ai-access).

## Why it runs all the time

UniFi keeps fine-grained data only briefly. On the console this was built against:

| Data | Kept by UniFi |
| --- | --- |
| 5-minute usage | 24 hours |
| Hourly usage per app | 7 days |
| Connection records (flows) | a count cap — 500,000 on a UCG Fiber with storage, ≈ 4 days on a busy network |
| Daily per-device totals, System Log | 90 days |
| Wi-Fi signal, equipment health | only "right now" |

NetLens samples the console every 5 minutes and keeps its own copy (usage and connection records 90 days, events and
Wi-Fi/equipment samples 90 days, daily totals a year), so history survives.

## Requirements

- A **UniFi OS console** (UDM, UDM Pro/SE, UCG Ultra/Max/Fiber, UDR, Cloud Key Gen2+). Built and
  tested on a UCG Fiber running UniFi Network 10.6.
- A **local API key**: UniFi Network → Settings → Control Plane → Integrations → *Create API Key*.
  It is shown only once — copy it then.
- Docker (Unraid, Synology, any Linux host). The container must be able to reach the console.

## Install

### Unraid

Search **NetLens** in Community Applications, or add the template from
[`unraid/netlens.xml`](unraid/netlens.xml). Start it and open the web UI.

### Docker

```bash
docker run -d --name netlens --restart unless-stopped \
  -p 3780:3780 \
  -v /path/to/netlens-data:/data \
  gjergjk/netlens:latest
```

Then open `http://<host>:3780`. Images: `gjergjk/netlens` (Docker Hub) and
`ghcr.io/georgeal78/netlens`, for amd64 and arm64.

### Docker Compose

See [`docker-compose.yml`](docker-compose.yml).

## First start

Open the web UI. A short setup asks for:

- your **UniFi console** address and the **API key**,
- the **site** (normally `default`) and your **timezone**,
- a **login password** — recommended, because the dashboard can block devices (leave both
  fields empty to run without one).

It checks the connection before finishing. Everything can be changed later in **Settings** (the
icon top right), including the password; **Log out** is there too. All data lives in `/data`.

**Forgot the password?** Start the container once with `NETLENS_RESET_PASSWORD=1`, set a new
password in the browser, then remove the variable.

### Backup, restore and moving history

**Settings → History**: *Export history* downloads one file with everything saved — usage,
connection records, network events, Wi-Fi and equipment samples. *Import history…* merges such
a file into this installation: days it does not have are added, a day it has is replaced only
by a fuller copy, and events and samples are added where missing. Use it to move to a new
server, to restore a backup, or to bring in history from another installation. Settings, the
API key and the password are never in the file. Days older than the 90 days of usage history
are skipped.

### Optional environment variables

For scripted installs these seed empty settings on the very first start; after that the
web UI is in charge: `UNIFI_HOST`, `UNIFI_API_KEY`, `UNIFI_SITE`, `UNIFI_SITE_ID`, `TZ`,
`SIEM_PORT`, `UI_PASSWORD`. `UNIFI_PORT` (default `3780`) is the port inside the container.

### Blocked-ad counts (optional)

Network events come from UniFi's System Log automatically. Only ad-block hits need syslog. The
container listens on port `5514` (TCP and UDP) by default: publish that port and point UniFi at
this server (CyberSecure → Traffic Logging → Activity Logging → SIEM Server). Clear the port in
Settings to turn the listener off.

## API and AI access

NetLens offers 31 operations (23 that read, 8 that make safe changes) in two forms, built from
one list so they always match:

- **MCP** at `http://<host>:3780/mcp` (Streamable HTTP, JSON answers). In Claude, add a custom
  connector with that address; in Claude Code,
  `claude mcp add --transport http netlens http://<host>:3780/mcp --header "Authorization: Bearer <key>"`.
- **REST**, described at `http://<host>:3780/api/openapi.json` (OpenAPI 3.1).

Reading covers every page: Overview findings, usage by device and app, sites, devices and
presence, the network map now or at any time in the last 90 days, equipment history, Wi-Fi,
Protection and alerts. The safe changes are: rename a device, set which device a VM runs on,
check a device on the network, add / switch / delete a usage alert, hide or show an Overview
finding, and refresh from UniFi. Nothing through this route can block a device, change
settings, the password or the key, import or export history, or stop NetLens.

With a login password, every call needs an access key: **Settings › API & AI** makes one,
*Read only* or *Read and safe changes*, sent as `Authorization: Bearer <key>`. Without a
password the API is open to anyone on your LAN, like the dashboard.

## Security

- **The login password is required** on first start: the dashboard can block devices.
- It is meant for your LAN. Do not expose it to the internet; use a VPN to reach it remotely.
- **Access key (optional)**: Settings › API & AI makes a key for scripts and assistants, sent as
  `Authorization: Bearer <key>`. A read-only key reads the JSON behind every page; a full key
  also makes the safe changes listed above. Neither can block devices, change settings or
  export history. Stored as a hash, shown once. `/mcp` refuses requests from other web pages.
- The API key never leaves the server: the UI only learns whether one is stored.
- Passwords are stored as scrypt hashes; sessions are signed cookies; five wrong passwords lock
  that address out for five minutes. Plain HTTP — fine on a home LAN, not across untrusted networks.

## Development

```bash
npm install
npm run dev        # API on :3780, UI with hot reload on :5173
npm run build      # production UI into dist/
npm start          # server + built UI on :3780
npm run audit      # every screen must add up (needs a running server)
```

Node 24+. Data goes to `./database` unless `UNIFI_DATABASE_DIR` is set.

## Credits

- Wi-Fi presence definitions (dwell time, favourite AP, presence pattern) follow
  [unifi-toolkit](https://github.com/Crosstalk-Solutions/unifi-toolkit)'s Wi-Fi Stalker (MIT);
  the choice of client and equipment metrics was inspired by
  [Unpoller](https://github.com/unpoller/unpoller) (MIT). Ideas, not code.
- [Public Suffix List](https://publicsuffix.org) (MPL-2.0).
- IP address data powered by [IPinfo](https://ipinfo.io), licensed CC BY-SA 4.0.

See [NOTICE](NOTICE).

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

[GPL-3.0](LICENSE).
