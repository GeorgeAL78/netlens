### Fixed
- Protection showed blocks under the wrong rule: a device's blocks took the name of any other rule that fired for it within three minutes, so an iPad's Apple blocks read "Kids Wi-Fi Blocks" or "Kids Wi-Fi Blocks Public DNS". Each block now keeps the rule UniFi recorded for it.
- Renamed rules and Objects read their current name everywhere: System Log events are matched to rules by id, and blocks stored under an old name ("Apple") show the new one ("Apple Full Block").
