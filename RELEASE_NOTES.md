**NetLens — a dashboard for UniFi networks.**

**Much lighter.** Connection records (flows) — about 90% of the saved data — now live in a
small embedded database (`/data/flows.db`) instead of daily JSON files that were all held in
memory. On a busy network with 30 days of history the server went from about 1.2 GB of
memory to under 150 MB, and long views (30 days) load a little faster. Every number is the
same: hundreds of reports were compared before and after, and all were identical.

**Upgrading** is automatic: on the first start the existing history is converted once (a few
seconds per day of history) and the old files shrink to a fraction of their size. Keep the
same `/data` folder.

Not affiliated with Ubiquiti. UniFi is a trademark of Ubiquiti Inc.
