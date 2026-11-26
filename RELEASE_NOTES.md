### Added
- **Band steering.** When a device's signal gets weak, the access point asks it to move to a better access point or band, and the device accepts or refuses. NetLens now shows how often each device was asked, at what signal and how it answered: in the Wi-Fi problems card, in Summary when it refused 3 or more times, and on Overview when a device keeps refusing (5 or more times, and most of its answers). Needs UniFi's Access Points device log sent to NetLens.
- **Gateway errors.** When the gateway's own message service keeps failing to reach another part of the console (for example its DNS component), Overview says so.

### Fixed
- A device's model is shown only when UniFi is at least 50% sure of it. UniFi named an iPhone 15 Pro Max "iPhone 11 Pro Max" at 6%. Otherwise the page shows the maker, and the tooltip gives UniFi's guess with its certainty. The type (phone, tablet…) is still used.
