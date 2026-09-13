/**
 * "Sold by Amazon only" — the client's filter, and the two ways it has actually failed.
 *
 * FAILURE 1 (2026-09-12, B0FP9ZZ68C): a marketplace listing was PUBLISHED.
 *   "Pokemon – Gem Pack Vol.2", $168.08, page reading "Ships from Amazon / Sold by Brick
 *   Arsenal LLC". The log shows `Scraping Amazon OLID for B0FP9ZZ68C` and no seller line after
 *   it: the read returned null, and a null seller FAILS OPEN, so it shipped.
 *
 * FAILURE 2 (2026-09-12, B0H7FDBNSB): a genuine Amazon restock was SUPPRESSED.
 *   A cached "ONE AT A TIME CANADA" verdict silenced a client priority ASIN while Amazon held
 *   the buy box. A competing monitor alerted it; the client did not.
 *
 * Both now resolve on the SAME live signal — `verifyAmazonListing`'s pinned-offer seller_name
 * (`amazon-verify.js:174`), which is structured JSON, scoped to the buy box by construction, and
 * was already being fetched and discarded on every verified event.
 *
 * These tests cover the PREDICATE. It is deliberately the only copy of this rule: the same rule
 * implemented twice is what killed every EARLY_SKU alert when deliver() and routeEvent() carried
 * different exemption lists.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { isSoldByAmazon, isThirdPartySeller } = require('../src/utils/amazon-seller');

describe('isSoldByAmazon', () => {
  test('Amazon storefronts pass', () => {
    for (const s of ['Amazon.ca', 'Amazon', 'Amazon.com', 'amazon.ca', '  Amazon.ca  ']) {
      assert.strictEqual(isSoldByAmazon(s), true, s);
    }
  });

  test('a marketplace name that merely CONTAINS "amazon" does not pass', () => {
    // The old rule was `seller.toLowerCase().includes('amazon')`. Every name below defeated it,
    // and defeating it means the listing is published to a paying client.
    for (const s of ['SuperAmazonDeals', 'TheAmazonStore', 'Amazonia Trading', 'eAmazonia',
      'Poke Amazon Cards']) {
      assert.strictEqual(isSoldByAmazon(s), false, `${s} is not Amazon`);
    }
  });

  test('Amazon-OWNED storefronts pass — suppressing them is the expensive error', () => {
    // "Amazon Warehouse" is Amazon. Reading it as third-party suppresses a legitimate alert,
    // which is the failure the client complained about (B0H7FDBNSB), so the rule admits any name
    // beginning with the standalone word rather than an exact-match list of guessed literals.
    // The offers API's exact wording for Amazon-sold items is unobserved; the shape is not.
    for (const s of ['Amazon Warehouse', 'Amazon Resale', 'Amazon Warehouse Deals']) {
      assert.strictEqual(isSoldByAmazon(s), true, `${s} is an Amazon storefront`);
    }
  });

  test('a French "sold and shipped by" PHRASE is not a seller name', () => {
    // Treating "vendu et expédié par X" as an Amazon marker made every French-locale scalper
    // read as Amazon. A phrase containing a seller name is not a seller name; only the SOLD BY
    // value may be passed here.
    assert.strictEqual(isSoldByAmazon('Vendu et expédié par Brick Arsenal LLC'), false);
    assert.strictEqual(isSoldByAmazon('Vendu et expédié par Japan Big Mall'), false);
  });

  test('a missing verdict is not Amazon', () => {
    // Must never read as "sold by Amazon", or a failed scrape silently whitelists everything.
    for (const s of [null, undefined, '', '   ']) assert.strictEqual(isSoldByAmazon(s), false);
  });

  test('real marketplace sellers are not Amazon', () => {
    for (const s of ['Brick Arsenal LLC', 'Poke Moo Canada', 'Sparkle JAPAN', 'Boreal Bay',
      'ONE AT A TIME CANADA', 'J & M COLLECTIBLES', 'Trilancer', 'TOSY Store']) {
      assert.strictEqual(isSoldByAmazon(s), false, s);
    }
  });
});

describe('isThirdPartySeller — the suppression question', () => {
  test('an unknown seller does NOT suppress', () => {
    // The single most important case, and the reason this is not `!isSoldByAmazon(seller)`.
    // The client chose fail-open explicitly after B0H7FDBNSB: an alert naming a third-party
    // seller is a wasted click, a suppressed Amazon restock is the product failing its one job.
    for (const s of [null, undefined, '', '   ']) {
      assert.strictEqual(isThirdPartySeller(s), false,
        'unknown must fail OPEN — suppressing here re-creates the lost-restock bug');
    }
  });

  test('a named marketplace seller suppresses', () => {
    assert.strictEqual(isThirdPartySeller('Brick Arsenal LLC'), true);
    assert.strictEqual(isThirdPartySeller('SuperAmazonDeals'), true);
  });

  test('Amazon itself does not suppress', () => {
    assert.strictEqual(isThirdPartySeller('Amazon.ca'), false);
    assert.strictEqual(isThirdPartySeller('Amazon'), false);
  });

  test('the two predicates agree everywhere except on unknown', () => {
    // Pins the ONE intended difference, so a later "simplification" to !isSoldByAmazon() fails
    // here instead of in production.
    const named = ['Amazon.ca', 'Amazon', 'Brick Arsenal LLC', 'SuperAmazonDeals', 'Boreal Bay'];
    for (const s of named) {
      assert.strictEqual(isThirdPartySeller(s), !isSoldByAmazon(s), s);
    }
    for (const s of [null, undefined, '']) {
      assert.strictEqual(isSoldByAmazon(s), false);
      assert.strictEqual(isThirdPartySeller(s), false, 'both false — unknown is neither');
    }
  });
});

describe('the gate uses the shared rule, not its own copy', () => {
  test('delivery.js no longer hand-rolls the amazon check', () => {
    const src = require('fs').readFileSync(require.resolve('../src/discord/delivery'), 'utf8');
    assert.ok(!/includes\(['"]amazon['"]\)/.test(src),
      'a second copy of this rule is how EARLY_SKU alerts were silently killed — import it');
    assert.match(src, /require\('\.\.\/utils\/amazon-seller'\)/);
  });

  test('the authoritative buy-box seller is actually consulted', () => {
    // verifyAmazonListing was returning the pinned offer's seller and nothing read it. If this
    // wiring is removed, B0FP9ZZ68C ships again.
    const src = require('fs').readFileSync(require.resolve('../src/discord/delivery'), 'utf8');
    assert.match(src, /event\._identity\.inStock[\s\S]{0,120}event\._identity\.seller/,
      'the pinned-offer seller must be read from the identity result');
    // The inStock guard is load-bearing, not decoration: amazon-verify falls back to
    // `listings[0]` and then to the cheapest priced offer when nothing is pinned. Without this
    // guard a cheapest-listing seller would be treated as the buy-box holder, and an Amazon
    // listing could be suppressed over an unrelated marketplace offer.
    assert.match(src, /_identity\.inStock/,
      'only a PINNED offer answers "who is selling this"; the fallback answers "who is cheapest"');
  });

  test('the buy box is read BEFORE the scrapes, not after', () => {
    // This ordering IS the fix. Reading the scrapes first cost two measured client-priority
    // restocks 12,907ms and 11,877ms, roughly 9s of it spent re-deriving a seller the offers
    // endpoint was about to return in ~1.5s. If someone moves the verify call back below the
    // scrapes, the latency returns silently and nothing else in the suite would notice.
    const src = require('fs').readFileSync(require.resolve('../src/discord/delivery'), 'utf8');
    const verify = src.indexOf('await this.verifyListing(');
    const scraper = src.indexOf('await fetchAmazonOlidAndSeller(');
    const playwright = src.indexOf('await scrapeAmazonOfferListingId(');
    assert.ok(verify > 0 && scraper > 0 && playwright > 0, 'all three call sites must exist');
    assert.ok(verify < scraper,
      'the offers read must precede the ScraperAPI scrape — it is faster AND better evidence');
    assert.ok(verify < playwright,
      'the offers read must precede the Playwright fallback');
  });

  test('the scrapes are still reachable as a fallback', () => {
    // The fix reorders; it must not DELETE the fallback. The cheap path returned a seller on 20
    // of 22 reads (all third-party), so it is what catches most marketplace listings when the
    // buy box gives nothing. Its gate must still admit a missing seller.
    const src = require('fs').readFileSync(require.resolve('../src/discord/delivery'), 'utf8');
    assert.match(src, /if \(!olid \|\| !seller\)/,
      'the scrape gate must still fire when either the OLID or the seller is missing');
  });

  test('the OLID is still fetched when absent — the alert needs the Offer Id field', () => {
    // With the seller resolved early, `if (!olid || !seller)` reduces to `if (!olid)`, so a
    // missing OLID is still fetched. 694 of ~699 tracked ASINs have one cached (median 25.8d
    // TTL), so this rarely costs anything — but a brand-new ASIN must not lose the field.
    const src = require('fs').readFileSync(require.resolve('../src/discord/delivery'), 'utf8');
    assert.match(src, /if \(result\.olid && !olid\)/, 'the OLID is still taken from the scrape');
    assert.match(src, /if \(olid\) event\._offerListingId = olid;/,
      'and still surfaced on the event for the embed');
  });

  test('a wrong cached verdict cannot outrank the live buy box', () => {
    // The B0H7FDBNSB direction, and it is now structural rather than a correction applied after
    // the fact: the buy-box seller is chosen FIRST, so a stale third-party verdict never reaches
    // the decision at all. `liveSeller ||` is the whole guarantee — if that precedence is
    // reversed, a 30-day-old "ONE AT A TIME CANADA" starts suppressing real restocks again.
    const src = require('fs').readFileSync(require.resolve('../src/discord/delivery'), 'utf8');
    assert.match(src, /let seller = liveSeller \|\| \(sellerMustBeFresh \? null : cachedSeller\);/,
      'the buy box must take precedence over the cached verdict');
  });

  test('the overrule is still logged when the buy box disagrees with the cache', () => {
    // Two of these fired in production within an hour of shipping the gate — each one a genuine
    // Amazon listing that would previously have been suppressed. The line must survive the
    // reorder, or the only visible evidence of the fix working disappears.
    const src = require('fs').readFileSync(require.resolve('../src/discord/delivery'), 'utf8');
    assert.match(src, /Seller gate overruled/,
      'a cache-vs-buy-box disagreement must stay visible in the log');
    assert.match(src, /const overruledCached = /,
      'and must be computed before `seller` is overwritten');
  });
});
