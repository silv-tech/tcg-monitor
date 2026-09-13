/**
 * The buy box is read FIRST, and a failure there must not disarm the seller gate.
 *
 * WHY THE ORDER CHANGED
 *
 * The offers endpoint returns the pinned offer's seller_name in ~1.2-1.7s and is the best signal
 * we have. It used to be read AFTER two scrapes that are slower and weaker, which cost two
 * measured client-priority restocks:
 *
 *   B0H7FDBNSB  RESTOCK  12,907ms
 *   B0H78BB9TY  RESTOCK  11,877ms
 *
 * roughly 9s of each spent re-deriving a seller the offers call was about to supply.
 *
 * WHAT THE REORDER MUST NOT COST
 *
 * 1. The fallback. The scrapes returned a seller on 20 of 22 reads (all third-party), so they are
 *    what catches most marketplace listings when the buy box gives nothing. Reordering must not
 *    delete them.
 * 2. The OLID. The offers payload contains NO offer-listing id — amazon-verify.js:154 says so
 *    explicitly, having checked the whole tree across three ASINs. The embed's Offer Id field
 *    comes only from the scrape path, so a missing OLID must still be fetched.
 * 3. Suppression, if the offers read fails. This is the new risk: the call now sits ahead of the
 *    scrapes, so an exception would abort enrichment before any seller was resolved and every
 *    third-party listing would fail open. verifyAmazonListing catches internally today, but that
 *    is its choice, not this file's guarantee — so the call carries its own try/catch.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const SRC = fs.readFileSync(require.resolve('../src/discord/delivery'), 'utf8');

describe('ordering', () => {
  test('the offers read precedes both scrapes', () => {
    const verify = SRC.indexOf('await this.verifyListing(');
    const scraper = SRC.indexOf('await fetchAmazonOlidAndSeller(');
    const playwright = SRC.indexOf('await scrapeAmazonOfferListingId(');
    assert.ok(verify > 0 && scraper > 0 && playwright > 0);
    assert.ok(verify < scraper && verify < playwright,
      'moving the verify call back below the scrapes silently restores a ~9s latency regression');
  });

  test('there is exactly ONE offers read per event', () => {
    // It was briefly called twice — once for the seller, once for identity — which is two paid
    // reads of the same endpoint for the same alert.
    const calls = SRC.match(/await this\.verifyListing\(/g) || [];
    assert.strictEqual(calls.length, 1, 'a second call is a second charge for the same answer');
  });
});

describe('the fallback survives', () => {
  test('both scrapes are still present and still gated on a missing seller OR olid', () => {
    assert.match(SRC, /await fetchAmazonOlidAndSeller\(/);
    assert.match(SRC, /await scrapeAmazonOfferListingId\(/);
    assert.match(SRC, /if \(!olid \|\| !seller\)/,
      'with the seller resolved this reduces to `if (!olid)`, which is what still fetches the OLID');
  });

  test('the OLID still reaches the embed', () => {
    assert.match(SRC, /if \(olid\) event\._offerListingId = olid;/);
  });
});

describe('a throwing offers read cannot disarm the gate', () => {
  test('the verify call is individually guarded', () => {
    // Extract the hoisted block and prove the try/catch wraps the call itself, not the whole
    // Amazon section — a catch further out would swallow the scrapes too, which is the failure
    // this exists to prevent.
    const start = SRC.indexOf('let liveSeller = null;');
    assert.ok(start > 0, 'the hoisted buy-box block must exist');
    const block = SRC.slice(start, start + 700);
    assert.match(block, /try \{[\s\S]{0,120}await this\.verifyListing\([\s\S]{0,80}\} catch/,
      'the offers read must carry its own try/catch so a throw cannot skip suppression');
  });

  test('and says so loudly rather than silently', () => {
    const start = SRC.indexOf('let liveSeller = null;');
    const block = SRC.slice(start, start + 700);
    assert.match(block, /logger\.warn\(/,
      'a swallowed exception here would make the gate look healthy while it was blind');
  });
});

describe('precedence', () => {
  test('the buy box outranks the cached verdict', () => {
    assert.match(SRC, /let seller = liveSeller \|\| \(sellerMustBeFresh \? null : cachedSeller\);/,
      'reversing this lets a 30-day-old third-party verdict suppress a real Amazon restock');
  });

  test('only a PINNED offer counts as the buy box', () => {
    // amazon-verify falls back to listings[0], then to the cheapest priced offer. Treating the
    // cheapest listing as the seller would suppress an Amazon alert over an unrelated offer.
    assert.match(SRC, /event\._identity && event\._identity\.inStock/);
  });

  test('non-verified event types are untouched by this path', () => {
    // SHIPPING_CHANGE, LOW_STOCK and friends never had an offers read and still do not — they
    // fall through to the cache and the scrapes exactly as before.
    assert.match(SRC, /if \(!event\._scanTier && VERIFY_TYPES\.has\(event\.type\)\) \{/);
  });
});
