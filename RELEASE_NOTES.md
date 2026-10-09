**NetLens — a dashboard for UniFi networks.**

**IPS signatures on threats.** UniFi's event log only says that an intrusion attempt was
blocked. NetLens now reads the blocked connection's own record and shows what actually
matched: the IPS signature (e.g. "ET USER_AGENTS Suspicious User-Agent …"), the IPS policy, the
domain, and UniFi's risk note. The Threats page gets an "IPS signatures" list.

UniFi keeps those connection records only about 4 days, so signatures are saved as soon as an
event appears; threat events older than that stay without one.

Not affiliated with Ubiquiti. UniFi is a trademark of Ubiquiti Inc.
