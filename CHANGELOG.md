# Changelog

## 2.5.0 — 2026-10-10

### Added
- NetLens checks your devices in the background every 5 minutes: it reads UniFi's device list (so new devices appear without opening anything) and checks every recently seen offline device on the network. The Devices tab shows each one as online, "on the network since …", or no answer — and, where NetLens has its own address on your network, whether the device that answered really has the right MAC.
- Device page: an online history for the last 7 days (online in UniFi, on the network only, or off).

### Changed
- A wired device whose link drops while it is idle is reported as asleep ("Office PC slept 23:00–07:10") instead of a cable problem — PCs drop to 10 Mbps when they sleep. A slow link while it is busy is still flagged.

## 2.4.0 — 2026-10-10

### Added
- Devices: "Check on network" for any device UniFi shows as offline, and "Check offline devices" for the whole list. NetLens pings the device's last address and, if pings are blocked, knocks on a few common ports — so a device that is on your network but not using the internet shows as "answers on the network". Only addresses on your own network are checked.

## 2.3.1 — 2026-10-10

### Changed
- Devices: new devices show a Rename button like the rest instead of an open name box.
- Devices: the name box closes without saving on Cancel, Esc, or a click outside it.

## 2.3.0 — 2026-10-09

### Added
- Devices tab: devices new in the last 7 days at the top, then every device UniFi knows — with the maker (vendor), where it connected (switch and port, or access point and band), IP, and when it was first and last seen.
- Name or rename any device from the Devices tab, from a device's page, or from Home's "new device" note. The name is saved in UniFi itself, so it shows in the UniFi app too.

### Fixed
- Devices you forget in UniFi no longer linger in NetLens's device lists.

## 2.2.1 — 2026-10-09

### Fixed
- Device lists in Alerts and the top-bar search no longer open with a run of bare MAC addresses. Named devices come first; unnamed ones show only while online, and old private Wi-Fi addresses appear only when you type.

## 2.2.0 — 2026-10-09

### Added
- Alerts: set a daily limit on time in use or data for an app or category on a device (or any device) — for example YouTube on the iPad over 2 hours a day. NetLens checks every 5 minutes and flags it once a day: on the Alerts tab (with a count), at the top of Home, and in a 30-day history. It only watches; nothing is blocked.
- Usage: "Alert me…" turns the current device and app filter into an alert.

## 2.1.0 — 2026-10-09

### Changed
- Usage: the app dropdown is replaced by one search box for apps, categories and devices — type a few letters, pick a result. Protocols, CDNs and unclassified traffic are grouped at the end instead of leading the list.
- Usage: a "Top apps" row for one-click filtering, and the Busiest app card no longer shows plumbing like SSL/TLS.
- The search box in the top bar now finds apps and categories as well as devices.

## 2.0.11 — 2026-10-09

### Changed
- UniFi's "STUN" traffic is shown as "Calls (FaceTime, WhatsApp, Meet…)": that is where UniFi files most FaceTime and other voice and video calls.

## 2.0.10 — 2026-10-09

### Added
- Usage: "Time in use" when you filter to a device or an app — how long it was in use in the period, overlapping sessions counted once.

### Fixed
- Usage: filtering to both a device and an app no longer shows two identical "Busiest app" cards.

## 2.0.9 — 2026-10-09

### Added
- A Usage tab in the top bar.
- Usage: an app picker again, listing apps counted by UniFi, apps found in connection records, and services on your own network.

## 2.0.8 — 2026-10-09

### Added
- Device page: the device's IP address that day (or the last one known, marked as such).

## 2.0.7 — 2026-10-09

### Added
- Days NetLens was not running now show where each device was connected, from UniFi's System Log: the access points a device used that day, band and signal, or the switch and port for wired devices.
- Device page for those days: signal per hour and time on each access point, from the same log.

## 2.0.6 — 2026-10-09

### Fixed
- Day: the Wi-Fi and Wired filters no longer come up empty on days NetLens was not running; devices show as wired or Wi-Fi from UniFi's own records.

## 2.0.5 — 2026-10-09

### Changed
- Home: the previous/next day buttons and calendar are always shown next to the periods; the "Pick a day" button is gone.

## 2.0.4 — 2026-10-09

### Changed
- "Pick a day" and every date button open a calendar; days with saved data are marked.

### Fixed
- Findings for a past day or a range no longer say "today".

## 2.0.3 — 2026-10-09

### Added
- Network: the real topology — each switch and access point under the device and port it is plugged into, wired devices grouped by switch port, with link speeds.
- Home: Today, 3, 7, 14 or 30 days, or pick a day.

## 2.0.2 — 2026-10-09

### Added
- Screenshots in the README and on Docker Hub.

### Fixed
- Home: repeated intrusion attempts from one address are one finding ("tried 4 times"), not one per attempt.
- Home: finding headlines are no longer coloured like warnings.
- Security: recent events without a connection record no longer say "older than 4 days".
- Device page: the Wi-Fi link rates fit on one line.

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
