### Changed
- Security › Blocked by your rules: click a row for its details — rule, device and its address, destination with every address it used, attempts and when, service — like the System Log events.
- Destinations show the site name (yt3.googleusercontent.com) with its addresses folded into one row, instead of one row per address.

### Fixed
- Blocked connections saved before v2.10.0 get their rule name filled in from UniFi while it still has the record (about 4 days). Connection-tracking blocks are named "Block Invalid Traffic".
- A blocked connection that matches a firewall event in the System Log uses that event's rule name (UniFi's connection records can call the same rule something else).
