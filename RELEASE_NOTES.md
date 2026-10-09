**NetLens — a dashboard for UniFi networks.** Formerly "UniFi NetLens".

**Renamed.** The project is now just *NetLens*. New image names: `gjergjk/netlens` and
`ghcr.io/georgeal78/netlens` (amd64, arm64); repository `GeorgeAL78/netlens`. If you ran
v1.0.0, point your container at the new image and keep the same `/data` folder — all
history and settings carry over.

**Setup in the browser.** Console address, API key, site, timezone and a login password are
entered in the web UI on first start (and changed later in Settings), instead of container
variables. Proper login page with signed session cookies; five wrong passwords lock that
address out for five minutes. Forgot it? Start once with `NETLENS_RESET_PASSWORD=1`.

Not affiliated with Ubiquiti. UniFi is a trademark of Ubiquiti Inc.
