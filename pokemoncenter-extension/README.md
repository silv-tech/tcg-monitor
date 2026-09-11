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
pinned tab on pokemoncenter.com (session already cleared)
   │
   ├─ content.js   ISOLATED world — holds the loop, talks to the extension
   │     GET /api/ingest/pokemoncenter/next    ← stalest products first
   │     window.postMessage ─────────────┐
   │                                     ▼
   ├─ page.js      MAIN world — does the actual reading
   │     fetch(product, {credentials:'include'})
   │     extract ONLY the ld+json block (~1.3KB, not the ~440KB page)
   │     ◄──────────── window.postMessage
   │
   ▼  POST /api/ingest/pokemoncenter           ← batched
monitor parses with its existing parseJsonLd
```

**Why two scripts.** The reading MUST happen in the page's own JavaScript world. Fetching from
the extension's isolated world was measured on 2026-09-11 to read **0 of 20 pages**, while the
identical URLs fetched by hand returned 451-459KB with a valid `Product` ld+json every time —
those hand tests had been run in the MAIN world without my realising it. In MV3 an isolated-world
fetch is not the page making a request, and a service that scores request provenance can tell.

`chrome.runtime` does not exist in the MAIN world, so `page.js` cannot reach the extension
itself; `content.js` is the relay between them. This needs Chrome 111+ for `"world": "MAIN"`.

Parsing stays on the server so there is only ever one parser to keep in step with the site.
Sending the block rather than the page turns a full catalogue pass from ~3.7GB into ~11MB.

## Things that are deliberate

- **The `tcgbridge=1` marker.** The content script matches every pokemoncenter.com page but does
  nothing unless that flag is present. Without it, a read loop would start inside the user's own
  shopping tabs.
- **A block is identified by what came back, not by its size.** Two traps, and the first version
  fell into both. Keying on `datadome` or `captcha-delivery` is wrong: those scripts load on
  perfectly good pages, and the adapter carries a note about that exact mistake discarding every
  real page. Keying on size alone is also wrong: "under 5000 bytes = blocked" turned one
  1053-byte response into a 30-minute halt, while the user saw no challenge and the next cycles
  fetched normally. A block is HTTP 429, or a body both too small to be a page **and** carrying
  challenge markup. Anything else short costs one product, not the run.
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
| `blocked (challenge …)` | A genuine challenge page. Paused 30 min. Lower concurrency |
| `blocked (HTTP 429)` | Rate limited by the site. Lower concurrency, raise the cycle pause |
| `N read nothing — 20x http200 short 1053b` | Reads are being refused. Usually the session, not the markup |
| `N read nothing — 20x threw: Failed to fetch` | The browser would not make the request at all — CSP or world problem |
| `N read nothing — 20x http200 no-ld 450kb` | Real pages arriving but the markup moved; check `extractProductLd` |
| `N read nothing — page world did not answer` | `page.js` did not load. Needs Chrome 111+ for `"world": "MAIN"` |
| `no push for Ns — restarting the tab` | Watchdog fired; usually an extension reload |
| nothing at all | Extension disabled, or the pinned tab was closed |

The monitor side reports the same story: `/api/health` shows `pokemoncenter` unhealthy if nothing
has been read successfully for 6 hours, whether that is because reads fail or because none are
being attempted.
