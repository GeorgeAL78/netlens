### Added
- **Cable link drops from the switch's own log.** With UniFi's Switches device log sent to NetLens (Activity Logging › SIEM Server › Devices › Switches), a wired device's page has a new **Cable link** card on the Connection tab. It lists each time the link went down and what the speed it came back at means: going to sleep (back at 10 Mbps), waking up, standby or a slower cable (below its usual speed), or back at full speed (a restart, a replug or a loose cable). Overview flags a port that drops 6 or more times a day for none of those reasons.
- **UniFi's own guesses of what a device is**, from the gateway's log, show with their percentages in the device's type picker and its icon's tooltip. They are never shown as the model.

### Fixed
- Lines from switches were filed under an unknown device, because switches send no time with them.
