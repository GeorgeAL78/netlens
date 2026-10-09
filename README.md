<p align="center"><img src="assets/icon.png" width="96" alt="NetLens icon"></p>

# NetLens

**A dashboard for UniFi networks.**

Self-hosted, it shows **who used how much, of what, and when**,
how good each device's **Wi-Fi** is, how your **access points, switches and gateway** are doing,
and what your firewall and intrusion prevention **blocked** — and it keeps that history,
which UniFi itself deletes after a day or a week.

> Not affiliated with, endorsed by, or sponsored by Ubiquiti Inc. UniFi is a trademark of Ubiquiti Inc.

## Features

**Usage**
- Traffic per device and per app (UniFi's own DPI counters), with hourly charts in 5-minute
  detail and **sessions**: when each app was used, for how long, and which servers were involved.
- **Every number on a screen comes from one source and adds up** — header, app table,
  categories, devices, chart and sessions. A built-in audit (`npm run audit`) checks every
  day × device × app combination.
- **Local-network traffic** (a media server, a NAS) shown separately — UniFi's usage counters
  only cover internet traffic, so a TV streaming from Jellyfin is otherwise invisible.
- **Missing data is marked, never shown as a quiet day**, and filled with per-device daily
  totals from UniFi's daily report where those still exist. Views up to **90 days**.

**Wi-Fi**
- Every Wi-Fi device, worst signal first: access point, band, signal now and on average, time
  spent below −80 dBm, roams.
- Per device: signal over time, time per access point, favourite access point, roaming history
  and a **presence heatmap** (when it is usually connected).

**Equipment** — gateway, switches and access points: CPU, memory, temperature (now and peak),
how busy each radio is, ports, uplinks, firmware updates.

**Threats** — UniFi's security events: intrusion attempts blocked and your firewall rules
firing, with top sources, targets and rules.

**Also** — a live gateway/WAN strip (status, ISP, latency, availability), network events
(connects, disconnects, roams with data used per connection), device blocking, an optional
syslog listener for blocked-ad counts, and a second "Timeline" view.

## Why it runs all the time

UniFi keeps fine-grained data only briefly. On the console this was built against:

| Data | Kept by UniFi |
| --- | --- |
| 5-minute usage | 24 hours |
| Hourly usage per app | 7 days |
| Connection records (flows) | a count cap — 500,000 on a UCG Fiber with storage, ≈ 4 days on a busy network |
| Daily per-device totals, System Log | 90 days |
| Wi-Fi signal, equipment health | only "right now" |

NetLens samples the console every 5 minutes and keeps its own copy (usage 30 days, events and
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
- a **login password** — required, because the dashboard can block devices.

It checks the connection before finishing. Everything can be changed later in **Settings**
(the menu), including the password; **Log out** is there too. All data lives in `/data`.

**Forgot the password?** Start the container once with `NETLENS_RESET_PASSWORD=1`, set a new
password in the browser, then remove the variable.

### Backup, restore and moving history

**Settings → History**: *Export history* downloads one file with everything saved — usage,
connection records, network events, Wi-Fi and equipment samples. *Import history…* merges such
a file into this installation: days it does not have are added, a day it has is replaced only
by a fuller copy, and events and samples are added where missing. Use it to move to a new
server, to restore a backup, or to bring in history from another installation. Settings, the
API key and the password are never in the file. Days older than the 30 days of usage history
are skipped.

### Optional environment variables

For scripted installs these seed empty settings on the very first start; after that the
web UI is in charge: `UNIFI_HOST`, `UNIFI_API_KEY`, `UNIFI_SITE`, `UNIFI_SITE_ID`, `TZ`,
`SIEM_PORT`, `UI_PASSWORD`. `UNIFI_PORT` (default `3780`) is the port inside the container.

### Blocked-ad counts (optional)

Network events come from UniFi's System Log automatically. Only ad-block hits need syslog: in
Settings set the listen port to `5514`, publish that port, and point UniFi at it (CyberSecure → Traffic Logging →
Activity Logging → SIEM Server), directly or through a relay such as syslog-ng.

## Security

- **The login password is required** on first start: the dashboard can block devices.
- It is meant for your LAN. Do not expose it to the internet; use a VPN to reach it remotely.
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

## License

[GPL-3.0](LICENSE).
