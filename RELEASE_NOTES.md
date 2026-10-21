### Changed
- Faster: NetLens remembers each screen's answer until its data changes (the next read from UniFi, Refresh, or a change you make), so going back to a page is instant; Overview is prepared right after each update. Updates now append only the new connection records instead of rewriting the whole day — on a busy network that froze every page for ~5 seconds on each update (now ~0.15 s).
- Network map: virtual machines and containers are folded under the device that runs them ("▸ 1 VM · 3 containers"), the map uses the full width with the legend on top, and Wi-Fi chips show band and signal with weak ones first.

### Added
- Device page: "Runs on …" for a VM or container — confirm or correct where it runs, or mark it as not a guest. Settings › Updates: turn the grouping off.
