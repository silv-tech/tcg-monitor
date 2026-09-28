# Amazon bridge

Reads amazon.ca buy boxes in a real browser and forwards them to the monitor. The server never
contacts amazon.ca for these reads.

## Why this exists

Amazon stock currently costs money and is still partial.

| route | what it costs | what it cannot do |
|---|---|---|
| `structured/amazon/offers` (paid) | ~4,800 credits/day at the safe 180s cadence | the 60s cadence the client wants is gated on a ~1.5M/mo plan upgrade |
| batched ASIN search (free) | 0 | reaches ~96.5% of tracked ASINs, and can **never** see a suppressed-OOS one — which is exactly the state a hot product sits in right before it restocks |
| raw `/dp/` via ScraperAPI | 18-20 credits (amazon.ca is billed as a premium domain) | — |
| **a real Canadian browser** | **0** | — |

A browser also removes failure modes the paid paths have to defend against:

- **The buy box IS the pinned offer.** A price read here is authoritative by construction. Most
  Amazon price paths are not scoped to the buy box, and one of them wrote $229.00 into
  `B0H78BB9TY` (real price $89.99); it survived indefinitely, and the monitor later published a
  -61% "price drop" that never happened.
- **The seller comes free.** The "sold by Amazon only" gate currently buys that with a paid
  offers call.
- **There is no marketplace to get wrong.** `tld=com` returns the US listing in USD for the same
  ASIN with no pinned offer, and nothing in the payload reveals the mistake — `price_symbol` is a
  bare "$" either way. A Canadian browser's own session cannot make that error.

## Setup

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
2. Click the extension icon to open its options.
3. Fill in:
   - **Monitor URL** — e.g. `https://www.nocturnemonitors.com` (must be one of the hosts in
     `manifest.json` → `host_permissions`, or the POST is blocked).
   - **Admin API key** — the monitor's `ADMIN_API_KEY`.
4. Leave the defaults (12 per cycle, 1 concurrent, 900ms gap, 20s between cycles), tick
   **Enabled**, then **Save**.
5. A pinned tab opens on `amazon.ca/?tcgbridge=1`. Leave it alone.

Watch the activity log on the options page. Within a minute you should see `pushed 12 — 12 read`.

## Start slow, and mean it

Amazon scores sessions and behaviour, and the address it sees is this machine's. This is stricter
than the Pokemon Center bridge on every axis, on purpose.

- **Use a Chrome profile that is not signed in to Amazon.** A challenge earned here can follow
  the *account*, not just the address — and this is a store the operator buys from personally.
  The same vendor class has already blocked this user's home network *and* their mobile data on
  a different site.
- Begin at **1 concurrent read** with the 900ms gap. Run a full day. If the log shows no
  `blocked` entry, consider raising concurrency to 2.
- If you ever see `blocked`, the bridge stops itself for **an hour**. Do not shorten that.

### What the defaults actually cost

At 12 per cycle, 1 concurrent, a 900ms base gap (jittered to ~1.35s average) and a 20s pause
between cycles, one cycle is about **35 seconds** — the slice dropped from ~134KB to ~4.2KB per
product on 2026-09-28, which took the per-page fetch down with it.

### The batch goes to the BLIND ASINs first

This is the whole point, and it is easy to get wrong. Of the 24 priority ASINs, **16 are already
visible to the free search-tile lane and we detect those in ~6s — faster than the competitor.**
Re-reading them in the browser buys nothing. The other **8 are invisible**: Amazon drops an ASIN
from `/s` when it has no offer, which is exactly the state a restock comes *out* of, so those are
covered only by the paid round-robin at **432s per ASIN** (24 ASINs x 18s effective; the observed
gap in live logs was 433s). Every missed alert came from that set.

So `getBridgeBatch` sorts **blind first**, then priority, then staleness:

| set | cadence |
|---|---|
| the ~8 blind priority ASINs | every **~43s**, free — against 432s on the paid lane |
| the other 16 priority ASINs | already ~6s via the free search-tile lane |
| the remaining ~770 | a full pass in roughly **2 hours** |

Blindness is read per-poll from `_stockUnobserved` (and from a missing row), **not** configured.
That matters: which ASINs are invisible changes as listings come and go, and a hardcoded list
would be wrong within days without anything failing loudly.

An earlier version capped priority at **half** the batch to stop the catalogue starving. That cap
produced ~220s per priority ASIN at 24 ASINs — it was arithmetic for the 10 ASINs we had when it
was written. Blind-first fixes it without needing the cap, because the blind set is small: the
tail still advances every cycle, and it is not uncovered in the meantime either — the free ASIN
search sweep reaches ~96.5% of tracked ASINs. The bridge is what reaches the rest, and what makes
every price authoritative.

### Why a fast free trigger is safe

`delivery.js` runs a paid verify on **every** RESTOCK before it alerts. The bridge is a trigger,
not a verdict: the "sold by Amazon" gate downstream is unchanged, and confirmation costs 5 credits
per *alert* (~250/day), not per poll.

## How it works

```
pinned tab on amazon.ca/?tcgbridge=1
   │
   ├─ content.js   ISOLATED world — holds the loop, talks to the extension
   │     GET /api/ingest/amazon/next        ← in-scope ASINs, stalest first, priority first
   │     window.postMessage ─────────────┐
   │                                     ▼
   ├─ page.js      MAIN world — does the actual reading
   │     fetch('/dp/<asin>', {credentials:'include'})
   │     extract ONLY the buy-box elements (~2-4KB, not the 400KB-1.5MB page)
   │     ◄──────────── window.postMessage
   │
   ▼  POST /api/ingest/amazon                ← batched  { records: [{asin, slice}] }

server: src/utils/amazon-buybox.js parses the slice
        src/adapters/amazon.js  writes the row into _knownProducts
        the NEXT poll diffs it against Redis and alerts, like every other lane
```

### Four decisions, each a hazard if reversed

**The reading happens in the MAIN world.** The Pokemon Center bridge read 0 of 20 pages from the
isolated content-script world while the identical URLs fetched by hand returned full pages every
time — because those hand tests had been run in the MAIN world without anyone realising it. In
MV3 an isolated-world fetch is not the page making a request: different credential handling,
different Sec-Fetch context. Do not "simplify" page.js and content.js into one file.

**It only runs in its own tab.** The content script matches every amazon.ca page but does nothing
unless the URL carries `tcgbridge=1`. The operator shops and buys here; without that marker a
read loop would start inside their signed-in browsing session.

**A block stops it for an hour rather than slowing it down.** Double the Pokemon Center bridge's
pause, because a challenged Amazon session can follow the account.

**Liveness is "did a push land", never "is the tab open".** The EB Games bridge lost eight
minutes with no symptom when a reload orphaned its content script: the tab was there, fully
loaded, with nothing driving it. The watchdog's limit clears a full challenge pause, so it cannot
re-navigate the tab during the hour the bridge is deliberately sitting still.

### What the browser does NOT send

Only the elements listed in `SLICE` in `page.js`. The add-to-cart and buy-now controls are
reduced to a presence marker, because their real markup carries a per-session CSRF blob — a live
token for the operator's own Amazon session, which must never leave their machine. There is a
test for that.

## Updating it

Chrome runs an unpacked extension from **wherever it was loaded**, so a `git pull` in the repo
does not reach the operator's copy. Bump `version` in `manifest.json` on every change; the
extension stamps it on each push as `x-bridge-version`, and the server logs it:

```
Amazon: BRIDGE PUSH v1.0.0 — 12 read, 1 changed
```

If that version is not the one you just shipped, the operator is running an old build.

## Server side

| endpoint | method | purpose |
|---|---|---|
| `/api/ingest/amazon/next?n=<N>` | GET | work queue — in-scope tracked ASINs, stalest first |
| `/api/ingest/amazon` | POST | results — `{ records: [{ asin, slice }] }` |

Both sit under `/api`, so they inherit the `x-api-key` check and the write rate limiter that
guard every other write endpoint. The queue is a GET on purpose: the write limiter is 30
requests/minute/IP, and polling for work must not eat the budget the pushes need.

The ingest path will **only** write stock for an ASIN the monitor already tracks. The bridge is a
reader, not a discovery lane — a mis-targeted tab would otherwise write one product's buy box
under another product's ASIN, straight into a paid alert channel.

## Tests

```
node --test tests/amazon-buybox.test.js tests/amazon-bridge.test.js tests/amazon-extension.test.js
```

`amazon-buybox` covers the stock/price/seller semantics, `amazon-bridge` the work queue and the
ingest guards, `amazon-extension` the page-side block detection and what is allowed to leave the
browser.
