### Added
- Wi-Fi join problems: every time a device tried to join the Wi-Fi and failed (couldn't log in, refused by the access point, no IP address, DNS failed), read from UniFi with every update and kept 90 days (UniFi keeps about 2).
  - Devices: a "Wi-Fi join problems" card (today / 7 days) with the usual cause, and a "failed joins" tag on those devices.
  - Device page: a "Wi-Fi joins" card (joins, failures by problem, access point, typical join time) and the failures in its event list.
  - Day: ✕ marks the hours with failed joins.
  - Home: flagged when a device fails 20+ times or more often than it gets in.
