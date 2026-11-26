### Changed
- **Devices, rebuilt.** It used to be one long list. Now:
  - Tiles at the top show what needs you: new devices, devices failing to join the Wi-Fi, a weak signal, blocked, or no name. Click one to show just those devices.
  - Each device shows what it is (an icon and UniFi's model name, such as "Apple iPhone"), where it is (access point and signal, or switch port and speed) and what it did today (data used and its top app).
  - Online devices are grouped by the access point or switch they use, or by type or network. Offline devices are collapsed at the bottom, most recently seen first.
  - Filter by online, offline, Wi-Fi, wired or pinned, and sort by name, most data today, last seen or newest.
  - VMs and containers sit under the server they run on, as on the Network map.
  - One ⋯ menu per device (rename, set type, pin, check on the network, apps, sites, block) replaces the buttons on every row. Select lets you name, check, pin or block several devices at once.
- **The device page is in tabs**: Summary, Apps and events, Connection, and Online history. Summary shows the four tiles, a short list of what stands out (weak signal, slow link, failed Wi-Fi joins), the day by hour, the top apps and the latest events. Each item links to the tab with the details. Rename, Set type, Sites and Block are under More.
- **Device types** come from UniFi's own fingerprint of each device. A device that runs VMs or containers counts as a server, a smart-home maker's device counts as smart home, and you can set any device's type yourself.

### Fixed
- The Firewall page's Threat protection card showed "Ad blocking: Off" and "DNS filtering: Off" even with a Content Filtering rule blocking ads. Those were UniFi's old switches. The card now shows your Content Filtering rules: which are on, what they block, for which network, and safe search.
