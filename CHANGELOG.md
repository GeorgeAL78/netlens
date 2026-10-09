# Changelog

## 2.0.1 — 2026-10-09

### Added
- Refresh button in the top bar: fetches the newest data from UniFi now and redraws the page.

## 2.0.0 — 2026-10-09

### Changed
- New interface, rebuilt from scratch: Home · Day · Network · Security, device search, Settings as a page.
- One interface instead of "classic" and "Timeline"; no Data menu (updates run by themselves).

### Added
- Home: plain-language findings (big transfers, weak Wi-Fi, slow links, threats, repeat offenders, new devices, equipment).
- Day: every device × hour, with roams, reconnects and blocks marked.
- Network: live map; access-point radios and clients, switch ports (speed, PoE, errors).
- Device page: traffic, signal or link speed, apps, sessions, events, CSV export, block / unblock.
- Security: investigate an outside address; hide noisy firewall rules.
- Wired: "Connected" shows UniFi's own connection time.

## 1.5.2 — 2026-10-09

### Added
- Version shown in the side menu.

### Changed
- Wi-Fi device detail: signal shows when it was sampled; link rates labelled Tx / Rx.
- Wi-Fi device detail: roams marked as coming from UniFi's log; a note shows when NetLens started sampling.

## 1.5.1 — 2026-10-09

### Added
- Setup: leave both password fields empty to run without a login (asks to confirm).
- Settings → Login: "Remove password" (needs the current password).

## 1.5.0 — 2026-10-09

### Added
- Usage: click a day's bar to open that day; click an hour's bar to see it in 5-minute steps; click a category slice to filter by it.
- Threats: click an event for its full detail — risk, policy, signature, source and destination, traffic.
- Wired tab: switch, port, link speed now and slowest, speed changes, time connected.

### Changed
- Settings redesigned: one "Settings" window with sections (UniFi console, General, Login, History, Ad-block counts).
- The syslog listener for ad-block counts is on by default (port 5514); clear the port in Settings to turn it off.

### Notes
- Threat details are available for events from the last ~4 days onward (how long UniFi keeps connection records).
- If another syslog service already uses port 5514 on the same host, map NetLens's 5514 to a different host port.

## 1.4.0 — 2026-10-09

### Added
- Threats: IPS signature, IPS policy, domain and risk for each blocked threat.
- Threats: "IPS signatures" top list.

### Fixed
- GitHub releases show their release notes again.

### Notes
- Signatures are available for threats from the last ~4 days (how long UniFi keeps connection records).

## 1.3.0 — 2026-10-08

### Added
- Settings → History: export all history to one file, and import such a file (backup, restore, move servers).
- Docker Hub page description.

### Changed
- Local devices known only by MAC or IP are named from UniFi's device list and known clients; devices with no name show their address.

### Fixed
- No more "injected env" line in the error log on every start.

## 1.2.0 — 2026-10-08

### Changed
- Connection records are stored in an embedded SQLite database (`/data/flows.db`) instead of in memory: ~1.2 GB → ~120 MB of RAM on a busy network.
- Existing history is converted automatically on first start.

## 1.1.0 — 2026-10-08

### Changed
- Renamed to **NetLens**. Images: `gjergjk/netlens`, `ghcr.io/georgeal78/netlens`. Keep the same `/data` folder.

### Added
- First-start setup in the web UI: console address, API key, site, timezone, login password. All editable later in Settings.
- Login page with session cookies; 5 failed attempts lock the address out for 5 minutes.
- `NETLENS_RESET_PASSWORD=1` to reset a forgotten password.

## 1.0.0 — 2026-10-08

### Added
- Traffic per device and per app, with 5-minute charts and sessions.
- Local-network traffic, shown separately.
- Missing days marked and filled from UniFi's daily totals; views up to 90 days.
- Wi-Fi, Equipment and Threats pages.
- Gateway/WAN strip, network events, device blocking, optional syslog listener.
- Unraid template; amd64 and arm64 images.
