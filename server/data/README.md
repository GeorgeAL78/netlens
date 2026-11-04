# Vendored data

Both files are committed rather than fetched at runtime: the app only ever talks to the
UniFi console, and a classifier that depends on the internet would fail quietly when the
network is the thing being measured.

| File | Source | Licence |
| --- | --- | --- |
| `public_suffix_list.dat` | https://publicsuffix.org/list/public_suffix_list.dat | MPL-2.0 (header retained) |
| `ip2asn.tsv.gz` | IPinfo Lite, https://ipinfo.io | CC BY-SA 4.0 — **attribution required** |
| `oui.tsv.gz` | Wireshark `manuf`, built from the IEEE's public OUI listings | GPL-2.0-or-later |

Both are snapshots. To refresh, download from the source URL above and replace the file —
no other change is needed. Bump `CLASSIFIER_VERSION` in `server/classify.js` afterwards so
cached days are re-annotated with the new data.

`ip2asn.tsv.gz` is **generated**, not the publisher's file: `scripts/build-ip2asn.mjs`
collapses IPinfo's /24-granular CSV (3.6M rows, 272 MB) into 395,159 ranges, 4.1 MB
gzipped. Columns: range start, range end, operator (the `as_domain`, falling back to
`as_name`). Rebuild with:

```
IPINFO_TOKEN=... node scripts/build-ip2asn.mjs
```

The token is read from the environment and must never be committed.

`oui.tsv.gz` is **generated** too: `prefix<TAB>maker`, for the addresses UniFi knows no maker for
(`server/oui.js`). No classifier is involved, so no version to bump. Rebuild with:

```
node scripts/build-oui.mjs manuf.gz
```

after downloading https://www.wireshark.org/download/automated/data/manuf.gz (at most once a
week, its header asks; the IEEE's own files refuse scripted downloads).

**Attribution:** IP address data powered by [IPinfo](https://ipinfo.io), licensed
CC BY-SA 4.0. Keep this notice if the repository is ever made public.

A public-domain alternative exists (https://iptoasn.com, PDDL-1.0) if the share-alike
term is ever a problem; it is larger and its labels are AS handles such as `GOOGLE`
rather than domains.
