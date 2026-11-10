### Fixed
- A wired device whose port is only 100 Mbps (many TVs) no longer reads as a slow link on the Network page, the Day grid or its own page, as long as it never linked faster in the last 30 days. Overview already worked this way. A device that drops from its usual speed is still flagged.
- On Network 11, which gave firewall rules new ids, a renamed rule's blocks in the System Log show its current name again. NetLens no longer depends on what UniFi's ids look like, and events from before such a change follow the rule to its new id.
