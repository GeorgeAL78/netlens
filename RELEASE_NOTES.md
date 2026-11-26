### Fixed
- The syslog sample at `/api/siem/unparsed` now names each line's real program (hostapd, kernel, mcad, dnsmasq…). UniFi access points and gateways put an extra tag before the program, so every line from one access point landed in a single group and busy programs pushed the rare lines out.
