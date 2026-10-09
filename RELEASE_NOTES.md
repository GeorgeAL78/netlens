**NetLens — a dashboard for UniFi networks.**

**Export and import history** — Settings → History. *Export history* downloads one file with
everything saved (usage, connection records, network events, Wi-Fi and equipment samples).
*Import history…* merges such a file: missing days are added, a day is replaced only by a fuller
copy. Use it for backups, restores, or moving to a new server. Settings, the API key and the
password are never in the file.

**Local devices get names.** Traffic to your own network that UniFi only knew by a MAC or IP
address is now named after the UniFi device or client it belongs to — on the test network the
largest one turned out to be the gateway itself. Anything with no name anywhere is shown by its
address instead of one anonymous "Local network" row.

**Cleaner logs.** The settings loader no longer prints an "injected env" line to the error
output on every start.

Not affiliated with Ubiquiti. UniFi is a trademark of Ubiquiti Inc.
