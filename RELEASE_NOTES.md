### Fixed
- Updating UniFi to Network 11 no longer wipes the day's usage in NetLens. Network 11 clears UniFi's own statistics when it is installed; NetLens replaced the current day with UniFi's empty one. It now keeps what it had and adds UniFi's new counting on top.

### Added
- Network: firmware on every card (UniFi OS for the gateway), "Firmware update available" with the new version, and end-of-life models flagged. The panel adds the model name, the device's address, Wi-Fi experience for access points and the gateway's PoE budget; the gateway shows its UniFi OS and Network versions.
- Firmware updates appear in each device's history and on the network timeline.
- Overview: a note when UniFi Network is updated (or an update is waiting), and a warning for end-of-life equipment.

### Changed
- On Network 11, NetLens no longer asks UniFi for per-device daily totals, which Network 11 no longer provides.
