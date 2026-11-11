### Changed
- Wi-Fi now has three tabs: Access points, Nearby networks and Devices.
- Channel suggestions come from UniFi's RF scans of every channel, which NetLens now keeps night after night (UniFi itself keeps only the latest). A move is suggested only to a channel clearly quieter on average that none of your other access points uses, and never to radar channels. The nearby-network counts no longer suggest channels: an access point hears its own channel best, so a channel you don't use could look empty when it isn't.

### Fixed
- Hidden networks are no longer lumped into one "network" on every channel, and a network on several channels shows each channel's own signal and when it was last heard.
- The Wi-Fi and Internet pages no longer stretch their tables across very wide screens, and Network's tab bar lines up with the page.
