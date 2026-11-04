### Added
- Download and upload (↓ ↑) everywhere traffic is shown: apps, categories, devices, sessions, top apps, Overview's lists and its Traffic line, By hour's totals, Sites, the Network map's panel, "Inside your network", and every hour or day tooltip. A device's CSV export gains down and up columns.

### Fixed
- Down and up were swapped wherever they came from connection records: a service's screen and Protection's event details. Totals were always right; only the direction was wrong. Stored history reads correctly with nothing to redo.
- Sessions listed the wrong destinations. UniFi does not say which connection belongs to which app, and NetLens took whatever the device was talking to at the time, so one big download appeared under every app beside it ("Windows Update: chatgpt.com") and local devices under internet traffic. A destination is now named only when it fits (never local, never bigger than the session, named like the app or a good part of a session of 50 MB or more) and reads "likely". A large session with no match says so; a small one stays blank.
- "SSL/TLS" and other encrypted sessions take a site's name only if that site is most of the session, and the Apps table's "mostly …" line only if the site fits the row's size.
- UniFi's "Wi-Fi Calling" now reads "Wi-Fi Calling or VPN (IPsec)": it is the name UniFi gives IPsec-style traffic, including a work laptop's VPN.
