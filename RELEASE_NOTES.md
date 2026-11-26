### Added
- **Wi-Fi problems from the access points' own log.** With UniFi's Access Points device log sent to NetLens (Settings › CyberSecure › Activity Logging › SIEM Server › Devices), NetLens now reads three things UniFi's API doesn't give:
  - **Why a device left the Wi-Fi.** Each disconnect in a device's Wi-Fi history says whether it left on its own or was removed by the access point, with the reason (for example "inactive for too long") and its signal just before.
  - **DNS timeouts.** How often a device's lookups timed out. Overview flags a device when it happens again and again (3 or more times and 10 or more lookups), with the signal it had.
  - **Anomalies the access point flags for a device**, such as DNS lookups timing out or slow responses, with its signal and satisfaction at the time.
- On the device page these appear in a new **Wi-Fi problems** card on the Connection tab, in Summary's list of what stands out, and in the day's events. Kept 90 days, like the other events.
