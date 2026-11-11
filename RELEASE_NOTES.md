### Added
- When a device moves to another port, Overview says where it moved from and to, and its page lists every port it was on, with times.
- A port starts over when a different device takes it: its busiest 5 minutes and drops count from then, and its history says which device connected instead of warning that the port got slower. Each device's own record follows it wherever it is plugged in.
- Overview's Network tab now lists restarts, times offline and firmware updates of your UniFi equipment in the period, and the notes about the internet port and the links between UniFi devices.

### Fixed
- Moving a device to another port no longer makes its usual speed look like a slow link for a month: a single speed reading taken while the cable moved no longer counts as the device's top speed.
- The Network panel is wider and its port table keeps every column in view, including drops and errors.
