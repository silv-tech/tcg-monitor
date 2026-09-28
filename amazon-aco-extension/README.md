# Amazon checkout extension

Buys a watched Amazon.ca product the moment the monitor reports it back in stock.

> **Read this first.** With auto-buy switched on, this places **real orders on your own Amazon
> account, with your own money, without asking.** It is not a draft, a cart, or a reminder. Set a
> max price on every item and test with auto-buy OFF before you trust it.

---

## How it works

Three parts, and only one of them is new:

```
  the monitor (already running)              this extension (your Chrome)
  ─────────────────────────────              ────────────────────────────
  Amazon restocks
      ↓
  poll detects it
      ↓
  identity gate  ─ is this really the product?
  seller gate    ─ is it sold by Amazon?
      ↓
  Discord alert  ──────────────┐
      ↓                        │
  publish trigger ─────────────┼──→  long-poll answers instantly
                               │          ↓
                               │     is this ASIN on my saved list?
                               │     is the price under my max?
                               │     was the seller confirmed?
                               │          ↓
                               │     open Amazon Buy Now, pinned to that offer
                               │          ↓
                               │     verify the checkout page is the right product
                               │          ↓
                               └──   submit Amazon's own order form
```

The extension is a **buyer waiting for a phone call**. It holds one connection open to your
monitor and does nothing until told. Because it runs in your browser, on your connection, with
your existing Amazon login, Amazon sees an ordinary customer — that is the entire reason this is
an extension rather than a server-side bot.

---

## Setup

### 1. Load it

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select this `amazon-aco-extension` folder
4. Click the extension icon to open the side panel

### 2. Connect it to the monitor

In the side panel, under **Connection**:

| field | value |
|---|---|
| Monitor URL | `https://www.nocturnemonitors.com` (or the Railway URL) |
| Admin API key | the monitor's `ADMIN_API_KEY` |

Press **Save**. The URL must be one of the hosts in `manifest.json` → `host_permissions`, or
Chrome blocks the request.

### 3. Add what it may buy

Under **Saved · Amazon** → fill the form → **Save item**.

| field | notes |
|---|---|
| ASIN | 10 characters, e.g. `B0DQNRLLLH` |
| Name | optional, just for the list |
| Quantity | 1–12 (Amazon's own ceiling) |
| **Max price** | **required** — see below |
| Buy even if seller unconfirmed | leave OFF unless you mean it |

**Max price is not optional and cannot be skipped.** It is the only thing standing between you
and a scalper relisting a $90 box at $400 the moment it restocks. An item saved without one would
simply never buy, so the form refuses to save it.

### 4. Turn it on — in this order

1. **Listening** → ON. It connects and starts watching. Nothing can be bought yet.
2. Leave **Place orders automatically** → OFF for your first restock.

With auto-buy off it still does everything: receives the trigger, opens the Amazon checkout tab,
verifies the page, and **stops at the review screen**. You finish the order by hand. That is how
you confirm it works without risking a wrong purchase.

Once you have seen it reach review correctly on a real restock, turn auto-buy on.

---

## The two switches

They are deliberately separate.

**Listening** — the kill switch. Off means no triggers are read at all. This is the one to reach
for when something looks wrong; **Stop all** sets both to off in one click.

**Place orders automatically** — whether a verified checkout is actually submitted. Off still
opens the tab and does the work.

Both start **OFF** on install and stay off until you switch them on.

---

## What makes it refuse to buy

Every one of these is tested (`tests/aco-guards.test.js`, 25 tests):

| it refuses when | why |
|---|---|
| the ASIN on the checkout page isn't the one we were triggered on | Amazon repurposes ASINs. One stored as a Pokémon card lot became a *"Sticky Soccer Dart Board Game"* — the monitor caught it. This is the same check, one step later |
| the price is over your max | scalper relist |
| the checkout holds more than one line item | that's your cart, not this product — it would buy everything in it |
| the seller was never confirmed as Amazon | the alert path deliberately fails *open* here; spending money is a different risk, so this fails *closed* |
| the trigger is older than 90 seconds | the offer is long gone |
| no max price is set | an open chequebook |
| quantity is out of range | a fat-fingered `100` buys 12, not 100 |
| Amazon shows a captcha or sign-in | see below |

**The governing rule: every ambiguous case resolves to "don't buy."** That is the opposite of the
monitor's alert rule, where an inconclusive read still *sends*. The costs invert — a missed alert
is a shrug, a missed purchase is a restock, a *wrong* purchase is money you cannot get back — so
the defaults invert with them.

---

## Challenges are handed to you, never solved

If Amazon shows a captcha, a passkey prompt, or bounces to sign-in, the extension **stops for 30
minutes** and says so in the activity log. It does not attempt to solve it and never will.

The tab is left open on purpose so you can deal with it. Same for every other outcome — if it
ordered you want the confirmation, if it stopped at review you need to finish it.

---

## Reading the activity log

| line | meaning |
|---|---|
| `Live · watching 3 item(s)` | connected and armed |
| `BUYING — $86.03 x1` | guards passed, opening checkout |
| `ordered in 3400ms` | order placed |
| `ready_for_review in 2900ms` | verified and waiting for you (auto-buy off) |
| `skipped — price $400 over max $100` | working exactly as intended |
| `skipped — seller not verified` | tick the per-item box if you want these |
| `blocked` | captcha — go look at the tab |
| `out_of_stock` | gone before checkout loaded. Normal on a hot drop |

---

## Troubleshooting

**"Not connected" / nothing in the log**
Check the URL and API key, press **Reconnect**. Confirm the monitor is up:
`curl -s <monitor>/api/health`

**Connected, but nothing ever fires**
Triggers are only published for **Amazon RESTOCK** events that pass the identity and seller gates.
A third-party restock is suppressed upstream and never reaches you — that is by design. Check
`GET /api/checkout/stats` on the monitor to see whether triggers are being published at all.

**It opens the tab but always says `wrong_identity`**
The checkout-page selectors are the least certain part of this. Tell me what the tab actually
shows and I will fix them — see the caveat below.

**Everything stopped and the log says `blocked`**
Amazon challenged the session. Solve it in the open tab. It resumes after 30 minutes, or press
**Reconnect** once you have cleared it.

---

## What has NOT been verified

Being straight about this, because it decides how you should test.

**The checkout-page selectors have never run against real Amazon.** The guard *logic* is unit
tested. The DOM selectors — the place-order control, the line-item count, the order total — are a
best reading of Amazon's checkout markup, and only a live restock confirms them.

This is why step 4 above says to leave auto-buy off for the first one. The worst case then is a
tab that stops at review or reports `wrong_identity`, and both are free.

**No `debugger` permission.** The competitor's extension needs it for Costco's payment iframe;
their Amazon path doesn't, and neither does ours. That means no alarming install warning and no
Chrome debugging banner across your session.

---

## Updating

Chrome runs an unpacked extension from wherever you loaded it, so `git pull` does **not** reach
your copy. After any change: `chrome://extensions` → the reload arrow on this extension.

Bump `version` in `manifest.json` when you change anything — the extension stamps it on every
result as `x-aco-version`, and the monitor logs it:

```
Checkout v0.1.0: B0DQNRLLLH — ordered @ $86.03 in 3400ms
```

If that version isn't the one you just shipped, Chrome is still running the old build.
