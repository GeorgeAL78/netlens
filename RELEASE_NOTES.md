### Added
- NetLens checks your devices in the background every 5 minutes: it reads UniFi's device list (so new devices appear without opening anything) and checks every recently seen offline device on the network. The Devices tab shows each one as online, "on the network since …", or no answer — and, where NetLens has its own address on your network, whether the device that answered really has the right MAC.
- Device page: an online history for the last 7 days (online in UniFi, on the network only, or off).

### Changed
- A wired device whose link drops while it is idle is reported as asleep ("Office PC slept 23:00–07:10") instead of a cable problem — PCs drop to 10 Mbps when they sleep. A slow link while it is busy is still flagged.
