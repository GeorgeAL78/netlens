<p align="center"><img src="assets/icon.png" width="96" alt="UniFi NetLens icon"></p>

# UniFi NetLens

A self-hosted dashboard for a UniFi network. It shows **who used how much, of what, and when**,
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
[`unraid/unifi-netlens.xml`](unraid/unifi-netlens.xml). Fill in the UniFi host, the API key and
a login password, then open the web UI.

### Docker

```bash
docker run -d --name unifi-netlens --restart unless-stopped \
  -p 3780:3780 \
  -e UNIFI_HOST=192.168.1.1 \
  -e UNIFI_API_KEY=your-key \
  -e UI_PASSWORD=choose-a-password \
  -e TZ=America/New_York \
  -v /path/to/netlens-data:/data \
  gjergjk/unifi-netlens:latest
```

Then open `http://<host>:3780`. Images: `gjergjk/unifi-netlens` (Docker Hub) and
`ghcr.io/georgeal78/unifi-netlens`, for amd64 and arm64.

### Docker Compose

See [`docker-compose.yml`](docker-compose.yml).

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `UNIFI_HOST` | `192.168.1.1` | IP or hostname of the console |
| `UNIFI_API_KEY` | — | Local API key (required) |
| `UNIFI_SITE` | `default` | Network site name; the site ID is looked up automatically |
| `UNIFI_SITE_ID` | — | Optional override for the site ID |
| `UI_PASSWORD` | — | Dashboard login (any user name). Strongly recommended |
| `TZ` | container's | Timezone for day boundaries and times (Unraid sets it for you) |
| `SIEM_PORT` | — | Optional syslog listener (e.g. `5514`, TCP and UDP) for blocked-ad counts |
| `UNIFI_PORT` | `3780` | Port inside the container |

Settings from the environment are applied at every start; the UniFi connection can also be
changed in the web UI. All data lives in `/data`.

### Blocked-ad counts (optional)

Network events come from UniFi's System Log automatically. Only ad-block hits need syslog: set
`SIEM_PORT=5514`, publish that port, and point UniFi at it (CyberSecure → Traffic Logging →
Activity Logging → SIEM Server), directly or through a relay such as syslog-ng.

## Security

- **Set `UI_PASSWORD`.** The dashboard can block devices on your network.
- It is meant for your LAN. Do not expose it to the internet; use a VPN to reach it remotely.
- The API key never leaves the server: the UI only learns whether one is stored.
- Login is HTTP Basic over plain HTTP — fine on a home LAN, not across untrusted networks.

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
