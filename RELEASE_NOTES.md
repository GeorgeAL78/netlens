### Fixed
- A container that ran past midnight stopped collecting: the new day was never opened, so its traffic was dropped and Usage showed 0 B until a restart or Refresh. Every 5-minute update now opens today and finishes yesterday, and today's connection records (Sessions, Sites) update every 5 minutes too, not only on Refresh.
- Clean shutdown: `docker stop` (and Ctrl+C) now lets a running fetch finish, closes the databases properly and exits, instead of being killed after 10 seconds.

After updating, press Refresh once: it re-reads the last 8 days, so days missed before the fix come back (hourly detail; UniFi keeps 5-minute detail for about a day and connection records for about 4).
