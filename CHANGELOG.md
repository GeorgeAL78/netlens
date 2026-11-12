# Changelog

## 2.32.6 — 2026-11-12

### Changed
- Channel suggestions also weigh how loud a channel is: never a channel whose strongest signal in UniFi's scans is more than 6 dB louder than yours, even if it looks idle. The channel list under the suggestions shows that loudness.

## 2.32.5 — 2026-11-12

### Added
- Channels around you: a Loudest in scan column (the strongest signal UniFi's nightly scan measured on each channel, so every channel shows how loud it is); a channel none of your access points uses now shows the loud networks heard when one last did (UniFi keeps about 30 days), with when; a 6 GHz table from the scans; the tables stack on narrower windows.

## 2.32.4 — 2026-11-12

### Changed
- Channels around you: a channel UniFi names no network on reads "not reported" (was "not listened"): its RF scan did measure it, which is the Busy column; UniFi just gives no list of networks there.

## 2.32.3 — 2026-11-12

### Fixed
- Wi-Fi › Nearby, Channels around you: each channel shows how busy it was in UniFi's RF scans (which cover every channel), and a channel where your access points heard nothing at all reads "not listened" instead of 0 (UniFi reports networks mostly on the channels your access points use, so 0 looked like a quiet channel). A line for 6 GHz says whether anything else is heard there. The tables fill the card.

## 2.32.2 — 2026-11-12

### Fixed
- Layout on wide screens: every page and its tab bar now sit in one centred column, so content and tabs no longer jump between the middle (Overview, Protection) and the left edge (Network, Wi-Fi, Internet, Live, Firewall rules); the Network map's internet bar centres its numbers beside the live graph; the column no longer shifts with the scrollbar. On a phone, Blocked and Devices no longer scroll sideways (a long rule name in a filter, the device rows).

## 2.32.1 — 2026-11-12

### Added
- Firewall rules: Recent changes, the rules, filters, speed rules, Objects, DNS records and port forwards added, removed, turned on or off or renamed in the last 30 days, as NetLens notices them on its hourly read.

### Fixed
- Firewall rules: a rule that is off now still shows what it blocked in the last 7 days while it was on (it read only "off"), and content filters show what they blocked too.

## 2.32.0 — 2026-11-12

### Added
- Protection › Firewall rules: UniFi's firewall rules in plain words, in the order UniFi checks them ("Block the Kids network → the apps YouTube, FaceTime", with schedules, ports and well-known DNS services by name), how often each blocked something in the last 7 days (a click opens those blocks), what the zones do when no rule matches, UniFi's built-in rules explained, and the rest of UniFi's Policy Engine on the same page: Objects, speed rules (QoS), content filters (ads, family filter, safe search), your local DNS records (with the device each address belongs to), and port forwards, traffic routes, older traffic rules, NAT and switch ACLs ("none" when there are none). Read hourly from UniFi Network 9 or later; NetLens never changes them. Also for scripts and assistants as `get_firewall_rules`.

## 2.31.4 — 2026-11-12

### Changed
- Wi-Fi shows every 2.4 GHz channel, not only 1, 6 and 11: how busy each was in UniFi's scans (Access points) and the loud networks on each (Nearby). Channels 2–5 and 7–10 are dimmed and marked as overlapping their neighbours; only 1, 6 and 11 are ever suggested.

## 2.31.3 — 2026-11-12

### Fixed
- The Network map marked the wrong port as a switch's uplink: it used the port number at the other end (the gateway's port 4) instead of the switch's own uplink port (5). The ↑ now sits on the right port, and its tooltip names what it connects to.

## 2.31.2 — 2026-11-12

### Fixed
- On the Live page, a switch's uplink port says so ("uplink to Cloud Gateway Fiber") and reads ↓ coming in, ↑ going out; a server's port is named after the server, not one of its containers.

## 2.31.1 — 2026-11-11

### Changed
- The live graph has axes: the rate on the left at round values, and the time along the bottom every 10 minutes.

## 2.31.0 — 2026-11-11

### Added
- A Live page (Network › Live): the internet line over the last hour, then live every few seconds; below it the busiest devices and every port, each with its own small graph. Click a device or port to draw its line over the main graph.
- Small live graphs on Overview (while looking at today) and beside the Network map's internet bar; both open the Live page. The Internet tab shows the same small graph.

### Fixed
- The Internet tab's per-day table no longer makes the page scroll sideways on a phone.

## 2.30.0 — 2026-11-11

### Added
- Live traffic on the Internet tab: a graph of the line's download and upload for the last 10 minutes, the busiest devices right now and every gateway and switch port, updated every few seconds while the page is open. NetLens reads UniFi for it only while someone is watching.

## 2.29.0 — 2026-11-11

### Added
- The internet line per day: download and upload, the busiest moments, average latency and time down, for the last 7 days in the Network map's internet panel and for the chosen period on the Internet tab.

## 2.28.2 — 2026-11-11

### Fixed
- The internet port's traffic reads from your side: ↓ download, ↑ upload.
- The internet line's "Up" is now "Reachable", with the period it covers: it is UniFi's own check (pings answered since the gateway started), which can differ from the figure on UniFi's dashboard.

## 2.28.1 — 2026-11-11

### Fixed
- When the gateway restarts, Overview says so once, instead of listing every access point as offline: the gateway runs UniFi Network and loses sight of them while it restarts.
- A device's places show the network it was on, and a change of network on the same port (a port briefly on the wrong VLAN) is a place of its own and a note on Overview. Each place shows the address the device had there.

### Changed
- README and Docker Hub: new screenshots, including the Wi-Fi, nearby networks and Internet pages.

## 2.28.0 — 2026-11-11

### Added
- When a device moves to another port, Overview says where it moved from and to, and its page lists every port it was on, with times.
- A port starts over when a different device takes it: its busiest 5 minutes and drops count from then, and its history says which device connected instead of warning that the port got slower. Each device's own record follows it wherever it is plugged in.
- Overview's Network tab now lists restarts, times offline and firmware updates of your UniFi equipment in the period, and the notes about the internet port and the links between UniFi devices.

### Fixed
- Moving a device to another port no longer makes its usual speed look like a slow link for a month: a single speed reading taken while the cable moved no longer counts as the device's top speed.
- The Network panel is wider and its port table keeps every column in view, including drops and errors.

## 2.27.0 — 2026-11-10

### Added
- Dropped packets per port: the Network panel's port table shows each port's drops in the last 24 hours and their share of its traffic (with flow control on or off in the tooltip), and the device history shows them per period. Overview tells you when a port throws away 0.5% or more of its packets, for example a gateway's internet port when faster devices upload.

## 2.26.1 — 2026-11-10

### Added
- Channel suggestions for 6 GHz too.

### Fixed
- Number columns in tables line up with their headings, and the Wi-Fi tables keep a readable width.

## 2.26.0 — 2026-11-10

### Changed
- Wi-Fi now has three tabs: Access points, Nearby networks and Devices.
- Channel suggestions come from UniFi's RF scans of every channel, which NetLens now keeps night after night (UniFi itself keeps only the latest). A move is suggested only to a channel clearly quieter on average that none of your other access points uses, and never to radar channels. The nearby-network counts no longer suggest channels: an access point hears its own channel best, so a channel you don't use could look empty when it isn't.

### Fixed
- Hidden networks are no longer lumped into one "network" on every channel, and a network on several channels shows each channel's own signal and when it was last heard.
- The Wi-Fi and Internet pages no longer stretch their tables across very wide screens, and Network's tab bar lines up with the page.

## 2.25.0 — 2026-11-10

### Added
- Network now has three tabs: Map, Wi-Fi and Internet.
- Wi-Fi: each access point's radios with channel, width, power, how busy the channel is and how much of that is other networks; on Network 11 also how often frames are sent again and the Wi-Fi experience. Every Wi-Fi device's signal, band, roams and failed joins, and devices stuck on 2.4 GHz that have used 5 or 6 GHz.
- Nearby networks, sifted: of the hundreds of networks your access points hear, only the ones loud enough to share a channel you use, plus how many loud networks sit on each channel so the quietest stands out. The rest are searchable by name, channel and band.
- Internet: availability and every outage, latency to UniFi's test targets, the busiest download and upload against your line's speed (each 5 minutes' peak on Network 11), public-address history and UniFi's last speed test.
- Links near their limit: Overview tells you when a device's busiest 5 minutes used 80% or more of its link, and the device's page and the switch's port table show the figure.
- AI access: two more read tools, the Wi-Fi and Internet pages.

## 2.24.1 — 2026-11-10

### Fixed
- A wired device whose port is only 100 Mbps (many TVs) no longer reads as a slow link on the Network page, the Day grid or its own page, as long as it never linked faster in the last 30 days. Overview already worked this way. A device that drops from its usual speed is still flagged.
- On Network 11, which gave firewall rules new ids, a renamed rule's blocks in the System Log show its current name again. NetLens no longer depends on what UniFi's ids look like, and events from before such a change follow the rule to its new id.

## 2.24.0 — 2026-11-10

### Added
- Traffic per switch port: each port on a switch or the gateway shows what went through it in the last 15 minutes, on its card and in the panel, and in the device's history the total per period and the peak rate. This includes local traffic (a NAS, a media server, backups), which UniFi's per-app counters never see.

## 2.23.1 — 2026-11-10

### Changed
- On Network 11, UniFi's per-device daily totals come from its new statistics engine (they fill in days NetLens has no detail for). Network 10 and older are read as before.

## 2.23.0 — 2026-11-10

### Fixed
- Updating UniFi to Network 11 no longer wipes the day's usage in NetLens. Network 11 clears UniFi's own statistics when it is installed; NetLens replaced the current day with UniFi's empty one. It now keeps what it had and adds UniFi's new counting on top.

### Added
- Network: firmware on every card (UniFi OS for the gateway), "Firmware update available" with the new version, and end-of-life models flagged. The panel adds the model name, the device's address, Wi-Fi experience for access points and the gateway's PoE budget; the gateway shows its UniFi OS and Network versions.
- Firmware updates appear in each device's history and on the network timeline.
- Overview: a note when UniFi Network is updated (or an update is waiting), and a warning for end-of-life equipment.

### Changed
- On Network 11, NetLens no longer asks UniFi for per-device daily totals, which Network 11 no longer provides.

## 2.22.0 — 2026-11-08

### Added
- API and AI access: an MCP endpoint at `/mcp` so Claude or another assistant can ask about your network and make safe changes, and the same operations as a REST API described at `/api/openapi.json`.
- The access key can now be *Read and safe changes*: rename a device, set where a VM runs, check a device, manage usage alerts, hide findings, refresh. No key can block devices, change settings or export history. Settings › API & AI.

## 2.21.3 — 2026-11-08

### Changed
- Network: the device and equipment panel closes when you click beside it, press Escape, or use its × button.

## 2.21.2 — 2026-11-08

### Added
- Equipment that UniFi reports as overheating is flagged: a red badge on its Network card, a line in its panel, and an Overview finding. Works for switches and access points without a temperature sensor, which still report this.

## 2.21.1 — 2026-11-08

### Changed
- Network: every switch and access point card shows its CPU, temperature and uptime, like the gateway's.

## 2.21.0 — 2026-11-08

### Changed
- Network, redesigned: the internet line across the top, then one card per gateway, switch and access point, from the gateway outward. Switch ports are tiles, devices are listed by port or by Wi-Fi band with their signal, and each card counts its weak signals and slow links. A line under the title sums up the network.
- Network: Map and History are two views instead of one long page; picking a time in History opens the map at that moment.

## 2.20.2 — 2026-11-08

### Changed
- Overview builds much faster on networks with PCs that sleep often or many devices: the wired-link check no longer scans every 5-minute record once per slow stretch, Wi-Fi and wired read the samples once between them, and new devices are found from the index. Same numbers as before.

## 2.20.1 — 2026-11-08

### Changed
- Overview builds 15 to 20% faster: Protection's incidents are worked out once instead of twice. Same numbers as before.
- Overview answers say how long each part took to build (a Server-Timing header), to find what is slow on a given network.

## 2.20.0 — 2026-11-08

### Added
- Network: see the map as it was at any time in the last 90 days. Pick a day and time, or step by 5 minutes or an hour, and every device shows where it was connected then, with the switches, access points and internet line as they were.
- Network: a history of the whole network over 24 hours, 7, 30 or 90 days, with internet speed, latency and devices online, and one list of every restart, outage, channel or port change, public IP change and new device. Click a bar or a time to open the map at that moment.

## 2.19.0 — 2026-11-08

### Added
- Usage detail and connection records are kept for 90 days instead of 30, like everything else NetLens stores. Overview, Sites and the failed-joins card get a 90 days button. Older days already gone are not brought back.

### Changed
- Pages are built on worker threads: while a long Overview or Apps report builds, the rest of NetLens answers at once (2 ms instead of over a second on a test copy). Same numbers as before; if a worker fails, the page is built as before.

## 2.18.2 — 2026-11-08

### Changed
- Apps and device reports over 7, 30 or 90 days build 3 to 6 times faster: the connection records behind them are read on every CPU core, read once per device instead of once per session, and dates are no longer formatted the slow way. Same numbers as before.

## 2.18.1 — 2026-11-08

### Fixed
- A device UniFi counted nothing for no longer reads as silent when its connection records show internet traffic: its page says how much, and with what, kept apart from UniFi's numbers. Typical for a container that talks only through a VPN tunnel.

## 2.18.0 — 2026-11-08

### Added
- Settings › Access key: a read-only key so a script or an assistant can read NetLens's data as JSON without the password. It can only read: it cannot block devices, change settings or export history. Shown once; replace it or turn it off at any time.

## 2.17.2 — 2026-11-08

### Fixed
- Choosing another period, day or filter now shows that it is loading: a moving bar and "Updating…" under the top bar, and the old numbers dimmed until the new ones arrive.

## 2.17.1 — 2026-11-05

### Changed
- Overview: Needs attention is now a separate switch that combines with the topic buttons, for example Wi-Fi problems only.
- Periods read the same across pages: Today, 7 days, 30 days, and 90 days where the data goes back that far. Overview's 3 and 14 days are gone.
- Activity's By hour is now called Timeline.
- Limits moved out of Activity to a bell in the top bar, which shows how many were reached today.
- The top bar stays tidy on narrow screens: search and its buttons share a second row.

### Fixed
- A sleeping PC that wakes for mail and updates no longer reads "dropped to 10 Mbps while in use" under Needs attention.

## 2.17.0 — 2026-11-05

### Added
- Overview: a finding when two access points share or overlap a Wi-Fi channel for an hour or more.
- Network: History on every switch, access point and gateway, over 24 hours, 7, 30 or 90 days: how busy each radio was, restarts, channel changes, port changes, new port errors and peak PoE.
- Network: an access point's radios show their channel width.

## 2.16.2 — 2026-11-04

### Changed
- Refreshed the two bundled lists: who runs an IP address (IPinfo Lite) and the public suffix list, both as of 2026-11-04. Connections UniFi could not name are labelled again from them, so the first start after this update takes a minute or two longer. Traffic figures do not change.

## 2.16.1 — 2026-11-04

### Fixed
- Devices: "Unknown maker" for ordinary devices that UniFi has no maker for (a Sony TV, Ring cameras, a Canon printer). NetLens now names them from a copy of the public address registry bundled with the app. UniFi's own answer still comes first, nothing is looked up online, and a device using a private address still reads that it hides its maker.

## 2.16.0 — 2026-11-04

### Added
- Download and upload (↓ ↑) everywhere traffic is shown: apps, categories, devices, sessions, top apps, Overview's lists and its Traffic line, By hour's totals, Sites, the Network map's panel, "Inside your network", and every hour or day tooltip. A device's CSV export gains down and up columns.

### Fixed
- Down and up were swapped wherever they came from connection records: a service's screen and Protection's event details. Totals were always right; only the direction was wrong. Stored history reads correctly with nothing to redo.
- Sessions listed the wrong destinations. UniFi does not say which connection belongs to which app, and NetLens took whatever the device was talking to at the time, so one big download appeared under every app beside it ("Windows Update: chatgpt.com") and local devices under internet traffic. A destination is now named only when it fits (never local, never bigger than the session, named like the app or a good part of a session of 50 MB or more) and reads "likely". A large session with no match says so; a small one stays blank.
- "SSL/TLS" and other encrypted sessions take a site's name only if that site is most of the session, and the Apps table's "mostly …" line only if the site fits the row's size.
- UniFi's "Wi-Fi Calling" now reads "Wi-Fi Calling or VPN (IPsec)": it is the name UniFi gives IPsec-style traffic, including a work laptop's VPN.

## 2.15.6 — 2026-10-27

### Changed
- Overview no longer flags a wired device for linking at 100 Mbps when that is its usual speed — it has never linked faster in the last 30 days (most TVs, consoles and smart devices). It still flags a device that used to link faster and dropped, which usually means a cable or port problem ("It linked at 1000 Mbps in the last 30 days").

### Added
- Hide on every Overview finding: "don't show this again" for that device or rule, kept on the server so it holds in every browser. Hidden findings are listed at the bottom of the feed ("Hidden (n)") with Show again, and a hidden finding comes back by itself if it turns more serious.

## 2.15.5 — 2026-10-26

### Fixed
- ChatGPT (and DeepSeek) were shown in the category "TopSites-Adult", which is where UniFi's app database files them. UniFi's "TopSites-…" categories now take NetLens's own category when every app in them is one NetLens knows (ChatGPT, DeepSeek → AI); otherwise they read "Popular sites (shopping)", "Popular sites (news)" and so on. Real adult sites stay in UniFi's separate "Adult" category.

## 2.15.4 — 2026-10-22

### Fixed
- Protection showed blocks under the wrong rule: a device's blocks took the name of any other rule that fired for it within three minutes, so an iPad's Apple blocks read "Kids Wi-Fi Blocks" or "Kids Wi-Fi Blocks Public DNS". Each block now keeps the rule UniFi recorded for it.
- Renamed rules and Objects read their current name everywhere: System Log events are matched to rules by id, and blocks stored under an old name ("Apple") show the new one ("Apple Full Block").

## 2.15.3 — 2026-10-21

### Fixed
- Protection: an intrusion from outside (a probe or a ping reply from an address on a reputation list) showed your own device as its destination, the outside address as your device's IP, and the networks the wrong way round. It now reads from the outside address to your device, "FIOS → Default", and notes that such a packet only gets in as an answer to something the device sent.
- The same intrusion no longer shows a second time as "Blocked by CINS Army Reputation List": UniFi's blocked connection behind an IPS alert is folded into the alert. IPS categories are spelled out ("CINS Army reputation list" instead of "ciarmy").

## 2.15.2 — 2026-10-21

### Fixed
- The distinct GB / TB sizes were missing in three places: a device's "Sessions and events", Overview's top-devices and top-apps lists, and the Apps page's "Busiest app" card.

## 2.15.1 — 2026-10-21

### Changed
- Sizes show their unit distinctly everywhere on the page: GB and TB in bold with the unit highlighted, MB and smaller quieter — and GB / TB keep one decimal, so a "237 GB" total over a "236 GB" session reads 236.5 and 236.3 and visibly adds up.
- Encrypted or unidentified sessions are named after where they went ("real-debrid.com (SSL/TLS) on tower.lan"), and destination lists show each site once ("real-debrid.com (3 addresses)") instead of UniFi's "<ip>_<name>" entries.
- Apps: when one encrypted row (SSL/TLS, QUIC, Unidentified) is at least half of everything in view and one destination carried at least half of it, the row says so ("mostly real-debrid.com (99%) · from connection records"). "Busiest app" keeps a real app unless it is under a tenth of the traffic.

## 2.15.0 — 2026-10-21

### Added
- Public IP history: Overview notes when your public IP changed ("Public IP changed: … → … at 3:14 AM"), and clicking the Internet box on the Network map shows the line's details and which address you had when, for the last 90 days. Recorded from v2.14.3 on.

## 2.14.4 — 2026-10-21

### Fixed
- "% up" showed UniFi's raw figure (99.93060000240803%); it is rounded to two decimals.

## 2.14.3 — 2026-10-21

### Added
- Overview › Right now and the Network map's Internet box: provider, public IP, % up (UniFi's WAN monitor), and current download / upload speed with how much of the WAN link it uses.

### Fixed
- The same "biggest app, however small" mistake in two more places: Overview's unusual-usage note and the Apps page's "Busiest app" card now show the real top entry when no named app is at least a fifth of the traffic.
- A bare IP address is never used as a device's "mostly …" label.

## 2.14.2 — 2026-10-21

### Fixed
- Overview › Top devices named a device's biggest recognised app even when it was a sliver of its traffic (tower.lan's 237 GB of Real-Debrid downloads showed as "GitHub" — 1.3 GB of container updates). A main app now has to be at least a fifth of the device's traffic; otherwise the destination from the connection records is shown ("mostly real-debrid.com"). The percentage now says "of all traffic".

## 2.14.1 — 2026-10-21

### Fixed
- Network map: a device that has gone quiet (often a container) is no longer drawn on the cable between two switches, or under "Elsewhere". When UniFi only knows it is somewhere behind a switch, the map keeps it at the last exact port NetLens saw it on in the last 30 days, marked ↺ (hover or click for when, and what UniFi reports now).

## 2.14.0 — 2026-10-20

### Changed
- Faster: NetLens remembers each screen's answer until its data changes (the next read from UniFi, Refresh, or a change you make), so going back to a page is instant; Overview is prepared right after each update. Updates now append only the new connection records instead of rewriting the whole day — on a busy network that froze every page for ~5 seconds on each update (now ~0.15 s).
- Network map: virtual machines and containers are folded under the device that runs them ("▸ 1 VM · 3 containers"), the map uses the full width with the legend on top, and Wi-Fi chips show band and signal with weak ones first.

### Added
- Device page: "Runs on …" for a VM or container — confirm or correct where it runs, or mark it as not a guest. Settings › Updates: turn the grouping off.

## 2.13.0 — 2026-10-20

### Changed
- Menus rearranged around one question each: **Overview** (was Home), **Activity** (By hour, Apps, Sites and Limits — was Day, Usage, Sites and Alerts — as tabs), **Devices**, **Network**, **Protection** (was Security). Old links still work.
- Alerts are called Limits; "Alert me…" is "Set a limit…". Overview's filters and labels use the new names.

### Fixed
- The Limits page said NetLens checks "every 5 minutes" although the interval is a setting.

## 2.12.0 — 2026-10-14

### Changed
- Security has two tabs: Blocks & intrusions, and Ads & trackers. The ads tab has the same layout: a chart by day, top devices and blocked sites, device and site filters, one line per device and blocked site, and a detail panel with every blocked lookup.

## 2.11.1 — 2026-10-14

### Added
- Security: drop-down filters above the list — type (blocked by your rules / intrusions), device, site, and rule or signature, each with its count; they combine, and Clear filters resets them.

## 2.11.0 — 2026-10-14

### Changed
- Security is one list of blocks. Each line is one incident: an intrusion, or a device blocked by one of your rules in one burst (for example "iPad → yt3.googleusercontent.com +5 more · Block YouTube on Kids Wi-Fi · ×40"). UniFi's System Log event for a burst and the blocked connections behind it are now the same line; click it for the event's details and every blocked connection.
- "Investigate <address>" finds every block that touched the address, including those only in the connection records.
- Ads and trackers stay in their own summary.

## 2.10.2 — 2026-10-14

### Changed
- Security › Blocked by your rules: click a row for its details — rule, device and its address, destination with every address it used, attempts and when, service — like the System Log events.
- Destinations show the site name (yt3.googleusercontent.com) with its addresses folded into one row, instead of one row per address.

### Fixed
- Blocked connections saved before v2.10.0 get their rule name filled in from UniFi while it still has the record (about 4 days). Connection-tracking blocks are named "Block Invalid Traffic".
- A blocked connection that matches a firewall event in the System Log uses that event's rule name (UniFi's connection records can call the same rule something else).

## 2.10.1 — 2026-10-14

### Changed
- Security: ad and tracker blocks get their own "Ads & trackers stopped" summary (per device and top blocked addresses), so "Blocked by your rules" lists only firewall rules and app / Object blocks.

## 2.10.0 — 2026-10-14

### Added
- Security: a "Blocked connections" card from UniFi's connection records, with the rule that blocked each one ("Ad Blocking", your firewall rules, app / Object blocks) and a filter per rule. These blocks never appear in UniFi's System Log, so the event list above could not show them. Rule names are recorded from this version on.

### Changed
- Refresh now fetches everything new — System Log events, Wi-Fi joins, device presence and health — not only traffic.

## 2.9.0 — 2026-10-14

### Added
- Wi-Fi join problems: every time a device tried to join the Wi-Fi and failed (couldn't log in, refused by the access point, no IP address, DNS failed), read from UniFi with every update and kept 90 days (UniFi keeps about 2).
  - Devices: a "Wi-Fi join problems" card (today / 7 days) with the usual cause, and a "failed joins" tag on those devices.
  - Device page: a "Wi-Fi joins" card (joins, failures by problem, access point, typical join time) and the failures in its event list.
  - Day: ✕ marks the hours with failed joins.
  - Home: flagged when a device fails 20+ times or more often than it gets in.

## 2.8.3 — 2026-10-14

### Added
- Settings › Updates: choose how often NetLens reads UniFi (1–1440 minutes, default 5). It takes effect at once, no restart.

## 2.8.2 — 2026-10-14

### Fixed
- A container that ran past midnight stopped collecting: the new day was never opened, so its traffic was dropped and Usage showed 0 B until a restart or Refresh. Every 5-minute update now opens today and finishes yesterday, and today's connection records (Sessions, Sites) update every 5 minutes too, not only on Refresh.
- Clean shutdown: `docker stop` (and Ctrl+C) now lets a running fetch finish, closes the databases properly and exits, instead of being killed after 10 seconds.

## 2.8.1 — 2026-10-11

### Added
- Devices: a Block / Unblock button on every device row (asks first; blocks in UniFi, like the device page).

## 2.8.0 — 2026-10-11

### Added
- Sites tab: every site each device connected to over the last 30 days, from UniFi's connection records. Category chips (social networks, gaming, school and learning, ads and tracking, shopping, AI, news, adult and the rest), search, group by domain, sort by connections, data or last seen, and the newest connection times for any site. Device pages link to it.
- Connections UniFi kept only as an IP address (a browser using secure DNS hides the name) are named when the address belongs to a watched site: NetLens looks those sites up itself every hour. A match on a shared CDN address is marked "possible".
- Devices: blocked devices are listed at the top with an Unblock button, tagged in the list, and counted in the header.

## 2.7.1 — 2026-10-10

### Changed
- The Unraid template now lives in GeorgeK's central template repository (github.com/GeorgeAL78/unraid-templates); its TemplateURL points there.

## 2.7.0 — 2026-10-10

### Changed
- New screenshots in the README and on Docker Hub, including the Devices and Alerts pages.
- Devices: when UniFi cannot be reached, the page shows the devices NetLens has stored (with their maker and where they last connected) instead of failing.

### Fixed
- Offline mode (`NETLENS_OFFLINE=1`) now never contacts UniFi, not just stops the timers.
- A new data folder set with `UNIFI_DATABASE_DIR` no longer adopts the retired PC app's database.

## 2.6.0 — 2026-10-10

### Added
- Home → Usage: the top 5 devices (with each one's main app and share) and the top 5 apps (with the device using each most), for today or any 3–30 day view.
- Home: a device using far more than usual (3× its normal day or more) is flagged.

### Fixed
- Home: on 3–30 day views the busiest-device chart shows one bar per day instead of piling everything into the last bar, and its link opens the right day.
- Home no longer says a device "used … of Unidentified"; traffic UniFi cannot classify is described as encrypted (for example a VPN).

## 2.5.0 — 2026-10-10

### Added
- NetLens checks your devices in the background every 5 minutes: it reads UniFi's device list (so new devices appear without opening anything) and checks every recently seen offline device on the network. The Devices tab shows each one as online, "on the network since …", or no answer — and, where NetLens has its own address on your network, whether the device that answered really has the right MAC.
- Device page: an online history for the last 7 days (online in UniFi, on the network only, or off).

### Changed
- A wired device whose link drops while it is idle is reported as asleep ("Office PC slept 23:00–07:10") instead of a cable problem — PCs drop to 10 Mbps when they sleep. A slow link while it is busy is still flagged.

## 2.4.0 — 2026-10-10

### Added
- Devices: "Check on network" for any device UniFi shows as offline, and "Check offline devices" for the whole list. NetLens pings the device's last address and, if pings are blocked, knocks on a few common ports — so a device that is on your network but not using the internet shows as "answers on the network". Only addresses on your own network are checked.

## 2.3.1 — 2026-10-10

### Changed
- Devices: new devices show a Rename button like the rest instead of an open name box.
- Devices: the name box closes without saving on Cancel, Esc, or a click outside it.

## 2.3.0 — 2026-10-09

### Added
- Devices tab: devices new in the last 7 days at the top, then every device UniFi knows — with the maker (vendor), where it connected (switch and port, or access point and band), IP, and when it was first and last seen.
- Name or rename any device from the Devices tab, from a device's page, or from Home's "new device" note. The name is saved in UniFi itself, so it shows in the UniFi app too.

### Fixed
- Devices you forget in UniFi no longer linger in NetLens's device lists.

## 2.2.1 — 2026-10-09

### Fixed
- Device lists in Alerts and the top-bar search no longer open with a run of bare MAC addresses. Named devices come first; unnamed ones show only while online, and old private Wi-Fi addresses appear only when you type.

## 2.2.0 — 2026-10-09

### Added
- Alerts: set a daily limit on time in use or data for an app or category on a device (or any device) — for example YouTube on the iPad over 2 hours a day. NetLens checks every 5 minutes and flags it once a day: on the Alerts tab (with a count), at the top of Home, and in a 30-day history. It only watches; nothing is blocked.
- Usage: "Alert me…" turns the current device and app filter into an alert.

## 2.1.0 — 2026-10-09

### Changed
- Usage: the app dropdown is replaced by one search box for apps, categories and devices — type a few letters, pick a result. Protocols, CDNs and unclassified traffic are grouped at the end instead of leading the list.
- Usage: a "Top apps" row for one-click filtering, and the Busiest app card no longer shows plumbing like SSL/TLS.
- The search box in the top bar now finds apps and categories as well as devices.

## 2.0.11 — 2026-10-09

### Changed
- UniFi's "STUN" traffic is shown as "Calls (FaceTime, WhatsApp, Meet…)": that is where UniFi files most FaceTime and other voice and video calls.

## 2.0.10 — 2026-10-09

### Added
- Usage: "Time in use" when you filter to a device or an app — how long it was in use in the period, overlapping sessions counted once.

### Fixed
- Usage: filtering to both a device and an app no longer shows two identical "Busiest app" cards.

## 2.0.9 — 2026-10-09

### Added
- A Usage tab in the top bar.
- Usage: an app picker again, listing apps counted by UniFi, apps found in connection records, and services on your own network.

## 2.0.8 — 2026-10-09

### Added
- Device page: the device's IP address that day (or the last one known, marked as such).

## 2.0.7 — 2026-10-09

### Added
- Days NetLens was not running now show where each device was connected, from UniFi's System Log: the access points a device used that day, band and signal, or the switch and port for wired devices.
- Device page for those days: signal per hour and time on each access point, from the same log.

## 2.0.6 — 2026-10-09

### Fixed
- Day: the Wi-Fi and Wired filters no longer come up empty on days NetLens was not running; devices show as wired or Wi-Fi from UniFi's own records.

## 2.0.5 — 2026-10-09

### Changed
- Home: the previous/next day buttons and calendar are always shown next to the periods; the "Pick a day" button is gone.

## 2.0.4 — 2026-10-09

### Changed
- "Pick a day" and every date button open a calendar; days with saved data are marked.

### Fixed
- Findings for a past day or a range no longer say "today".

## 2.0.3 — 2026-10-09

### Added
- Network: the real topology — each switch and access point under the device and port it is plugged into, wired devices grouped by switch port, with link speeds.
- Home: Today, 3, 7, 14 or 30 days, or pick a day.

## 2.0.2 — 2026-10-09

### Added
- Screenshots in the README and on Docker Hub.

### Fixed
- Home: repeated intrusion attempts from one address are one finding ("tried 4 times"), not one per attempt.
- Home: finding headlines are no longer coloured like warnings.
- Security: recent events without a connection record no longer say "older than 4 days".
- Device page: the Wi-Fi link rates fit on one line.

## 2.0.1 — 2026-10-09

### Added
- Refresh button in the top bar: fetches the newest data from UniFi now and redraws the page.

## 2.0.0 — 2026-10-09

### Changed
- New interface, rebuilt from scratch: Home · Day · Network · Security, device search, Settings as a page.
- One interface instead of "classic" and "Timeline"; no Data menu (updates run by themselves).

### Added
- Home: plain-language findings (big transfers, weak Wi-Fi, slow links, threats, repeat offenders, new devices, equipment).
- Day: every device × hour, with roams, reconnects and blocks marked.
- Network: live map; access-point radios and clients, switch ports (speed, PoE, errors).
- Device page: traffic, signal or link speed, apps, sessions, events, CSV export, block / unblock.
- Security: investigate an outside address; hide noisy firewall rules.
- Wired: "Connected" shows UniFi's own connection time.

## 1.5.2 — 2026-10-09

### Added
- Version shown in the side menu.

### Changed
- Wi-Fi device detail: signal shows when it was sampled; link rates labelled Tx / Rx.
- Wi-Fi device detail: roams marked as coming from UniFi's log; a note shows when NetLens started sampling.

## 1.5.1 — 2026-10-09

### Added
- Setup: leave both password fields empty to run without a login (asks to confirm).
- Settings → Login: "Remove password" (needs the current password).

## 1.5.0 — 2026-10-09

### Added
- Usage: click a day's bar to open that day; click an hour's bar to see it in 5-minute steps; click a category slice to filter by it.
- Threats: click an event for its full detail — risk, policy, signature, source and destination, traffic.
- Wired tab: switch, port, link speed now and slowest, speed changes, time connected.

### Changed
- Settings redesigned: one "Settings" window with sections (UniFi console, General, Login, History, Ad-block counts).
- The syslog listener for ad-block counts is on by default (port 5514); clear the port in Settings to turn it off.

### Notes
- Threat details are available for events from the last ~4 days onward (how long UniFi keeps connection records).
- If another syslog service already uses port 5514 on the same host, map NetLens's 5514 to a different host port.

## 1.4.0 — 2026-10-09

### Added
- Threats: IPS signature, IPS policy, domain and risk for each blocked threat.
- Threats: "IPS signatures" top list.

### Fixed
- GitHub releases show their release notes again.

### Notes
- Signatures are available for threats from the last ~4 days (how long UniFi keeps connection records).

## 1.3.0 — 2026-10-08

### Added
- Settings → History: export all history to one file, and import such a file (backup, restore, move servers).
- Docker Hub page description.

### Changed
- Local devices known only by MAC or IP are named from UniFi's device list and known clients; devices with no name show their address.

### Fixed
- No more "injected env" line in the error log on every start.

## 1.2.0 — 2026-10-08

### Changed
- Connection records are stored in an embedded SQLite database (`/data/flows.db`) instead of in memory: ~1.2 GB → ~120 MB of RAM on a busy network.
- Existing history is converted automatically on first start.

## 1.1.0 — 2026-10-08

### Changed
- Renamed to **NetLens**. Images: `gjergjk/netlens`, `ghcr.io/georgeal78/netlens`. Keep the same `/data` folder.

### Added
- First-start setup in the web UI: console address, API key, site, timezone, login password. All editable later in Settings.
- Login page with session cookies; 5 failed attempts lock the address out for 5 minutes.
- `NETLENS_RESET_PASSWORD=1` to reset a forgotten password.

## 1.0.0 — 2026-10-08

### Added
- Traffic per device and per app, with 5-minute charts and sessions.
- Local-network traffic, shown separately.
- Missing days marked and filled from UniFi's daily totals; views up to 90 days.
- Wi-Fi, Equipment and Threats pages.
- Gateway/WAN strip, network events, device blocking, optional syslog listener.
- Unraid template; amd64 and arm64 images.
