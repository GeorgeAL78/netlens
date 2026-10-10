### Changed
- New screenshots in the README and on Docker Hub, including the Devices and Alerts pages.
- Devices: when UniFi cannot be reached, the page shows the devices NetLens has stored (with their maker and where they last connected) instead of failing.

### Fixed
- Offline mode (`NETLENS_OFFLINE=1`) now never contacts UniFi, not just stops the timers.
- A new data folder set with `UNIFI_DATABASE_DIR` no longer adopts the retired PC app's database.
