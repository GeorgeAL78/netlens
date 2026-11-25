### Changed
- A redesigned interface. Every page sits in a sidebar, grouped as Overview, Activity, Devices, Network and Protection, with Limits now under Protection instead of a bell icon. On phones there's a bottom bar plus a More sheet listing every page. Nothing was removed, and old links still open the same pages.
- A new look with a light theme. Choose automatic (follows your device), light or dark at the foot of the sidebar.
- Faster first load: each page's code downloads only when you open it.

### Added
- Find anything: press Ctrl+K (or /) to jump to any page, pinned device, device, app or category, or to refresh, switch theme or pin the device you're viewing.
- Pinned devices: pin a device from its page and it stays in the sidebar on every screen and browser. Scripts and assistants can use it too, as `list_pinned_devices` and `pin_device`.
- Internet › Your lines: which internet line carries traffic and which is on standby, and every switch between them. Overview reports when the gateway fails over to the backup line and when it switches back. Needs UniFi Network 11.
- Wi-Fi › How your access points hear each other: how loudly your own access points hear each other on each band, from UniFi's Channel AI, flagging pairs on overlapping channels that have to take turns. Also shows when Channel AI runs.
- Firewall rules › Threat protection: whether UniFi's intrusion prevention is set to block or only detect, how many threat categories it covers and on which networks, and whether ad blocking, DNS filtering and a honeypot are on.
