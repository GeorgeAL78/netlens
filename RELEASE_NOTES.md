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
