# Pokemon Center bridge

Reads Pokemon Center product stock in a real browser and forwards it to the monitor. The server
never contacts pokemoncenter.com.

## Why this exists

pokemoncenter.com is behind DataDome. Measured, from a residential address:

| route | result |
|---|---|
| residential raw HTTP | 403 |
| residential + Patchright | 403 |
| Patchright direct | Imperva interstitial |
| ScraperAPI std / premium / ultra | 500 after ~55s |
| ScraperAPI Async | 5.8 min, then a DataDome block page |
| Bright Data unlocker | works, ~26s median |
| **a real Chrome** | **works, free** |

Bright Data works but manages ~1,459 checks a day. The store has **8,415 products**, so one full
pass takes **21 days**. A real browser does the same pass in about **2 hours**:

```
fetch(product, { credentials: 'include' })  ->  451KB, real ld+json, no challenge
fetch(product, { credentials: 'omit'    })  ->  859 bytes, DataDome challenge
four in parallel                            ->  3.6s wall  =>  ~1.1 products/sec
```

`credentials: 'include'` is not optional. Without cookies the same fetch is challenged.

## Setup

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
2. Click the extension icon to open its options.
3. Fill in:
   - **Monitor URL** — e.g. `https://www.nocturnemonitors.com` (must be one of the hosts in
     `manifest.json` → `host_permissions`, or the POST is blocked).
   - **Admin API key** — the monitor's `ADMIN_API_KEY`.
4. Leave the defaults (20 per cycle, 2 concurrent, 5s pause) and tick **Enabled**, then **Save**.
5. A pinned tab opens on `pokemoncenter.com/en-ca/?tcgbridge=1`. Leave it alone.

Watch the activity log on the options page. Within a minute you should see `pushed 20 — 20 read`.

## Start slow, and mean it

DataDome scores behaviour, and the address it sees is this machine's. The same vendor has already
blocked this user's home network *and* their mobile data on a different site — and Pokemon Center
is a store they buy from personally.

- Begin at **2 concurrent reads**. Measured safe at 4; 2 leaves margin.
- Run a full day. If the log shows no `blocked` entry, consider raising concurrency by one.
- If you ever see `blocked`, the bridge stops itself for 30 minutes. Do not shorten that.
- Prefer running this in a Chrome profile that is **not signed in** to Pokemon Center, so the
  traffic is not attached to a buying account.

## How it works

```
pinned tab (has already cleared DataDome)
   │  GET  /api/ingest/pokemoncenter/next   ← stalest products first
   │  fetch each product page, same-origin, with cookies
   │  extract ONLY the ld+json block (~1.3KB, not the ~440KB page)
   ▼  POST /api/ingest/pokemoncenter        ← batched
monitor parses with its existing parseJsonLd
```

Parsing stays on the server so there is only ever one parser to keep in step with the site.
Sending the block rather than the page turns a full catalogue pass from ~3.7GB into ~11MB.

## Things that are deliberate

- **The `tcgbridge=1` marker.** The content script matches every pokemoncenter.com page but does
  nothing unless that flag is present. Without it, a read loop would start inside the user's own
  shopping tabs.
- **Block detection is by size, not by keyword.** `datadome` and `captcha-delivery` scripts load
  on perfectly good pages — the adapter carries a note about that exact mistake discarding every
  real page. A challenged body is ~859 bytes; a real product page is 440-451KB.
- **Liveness is "did a push land", never "is the tab open".** The EB Games bridge lost 8 minutes
  of pushes with no symptom when an extension reload orphaned its content script: the tab was
  still there, fully loaded, with nothing driving it. A watchdog restarts the tab after silence.
- **The work queue is a GET.** The monitor rate-limits writes to 30/min per IP, shared with the
  EB Games bridge. Polling for work must not spend that budget.
- **Parked products are still offered.** Parking counts *Bright Data* failures; a browser can
  read those pages fine.

## Troubleshooting

| Log line | Meaning |
|---|---|
| `not configured — open the extension options` | Monitor URL or API key is blank |
| `work HTTP 401` | Wrong API key |
| `work HTTP 503` | Monitor is up but the Pokemon Center adapter is not running |
| `blocked (short body …)` | DataDome challenged a fetch. Paused 30 min. Lower concurrency |
| `blocked (HTTP 429)` | Rate limited by the site. Lower concurrency, raise the cycle pause |
| `N pages parsed nothing` | Markup may have moved — check `extractProductLd` |
| `no push for Ns — restarting the tab` | Watchdog fired; usually an extension reload |
| nothing at all | Extension disabled, or the pinned tab was closed |

The monitor side reports the same story: `/api/health` shows `pokemoncenter` unhealthy if nothing
has been read successfully for 6 hours, whether that is because reads fail or because none are
being attempted.
