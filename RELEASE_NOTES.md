### Changed
- Sizes show their unit distinctly everywhere on the page: GB and TB in bold with the unit highlighted, MB and smaller quieter — and GB / TB keep one decimal, so a "237 GB" total over a "236 GB" session reads 236.5 and 236.3 and visibly adds up.
- Encrypted or unidentified sessions are named after where they went ("real-debrid.com (SSL/TLS) on tower.lan"), and destination lists show each site once ("real-debrid.com (3 addresses)") instead of UniFi's "<ip>_<name>" entries.
- Apps: when one encrypted row (SSL/TLS, QUIC, Unidentified) is at least half of everything in view and one destination carried at least half of it, the row says so ("mostly real-debrid.com (99%) · from connection records"). "Busiest app" keeps a real app unless it is under a tenth of the traffic.
