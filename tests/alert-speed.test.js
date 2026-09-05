/**
 * The ⚡ badge must mean what a customer reads it to mean.
 *
 * It used to be Date.now() - _detectedAt, where _detectedAt is stamped when our fetch STARTS.
 * That reports how long our own request took — around 1s — regardless of the poll interval.
 * With shops on a 30s cycle, a listing that had been live for 29 seconds still showed "⚡ 1.0s".
 * The number was real, it just was not the number anyone thinks it is.
 *
 * The promise is: listing goes live at 16:00:00, alert lands at 16:00:09, badge says 9.0s.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { EVENT_TYPES } = require('../src/core/events');

// Mirrors alertSpeed() in src/discord/embeds.js.
function alertSpeed(event, now = Date.now()) {
  const publishedAt = event.product && event.product.publishedAt;
  if (event.type === EVENT_TYPES.NEW_SKU && publishedAt) {
    const ms = now - publishedAt;
    if (ms >= 0 && ms < 10 * 60 * 1000) return `${(ms / 1000).toFixed(1)}s`;
    return null;
  }
  if (event._prevPollAt) {
    const ms = now - event._prevPollAt;
    if (ms >= 0 && ms < 10 * 60 * 1000) return `≤${(ms / 1000).toFixed(1)}s`;
  }
  return null;
}

const NOW = 1_700_000_000_000;
const newSku = (publishedAt, extra = {}) => ({
  type: EVENT_TYPES.NEW_SKU, product: { sku: 'x', publishedAt }, ...extra,
});

describe('alert speed: true latency where the retailer tells us', () => {
  test('a listing live 9s ago reads 9.0s — the actual promise', () => {
    assert.strictEqual(alertSpeed(newSku(NOW - 9000), NOW), '9.0s');
  });

  test('a listing live 15s ago reads 15.0s, not our request duration', () => {
    // The old code would have shown ~1s here and hidden a 15s detection.
    assert.strictEqual(alertSpeed(newSku(NOW - 15000), NOW), '15.0s');
  });

  test('sub-second is reported honestly too', () => {
    assert.strictEqual(alertSpeed(newSku(NOW - 400), NOW), '0.4s');
  });
});

describe('alert speed: no false precision when we cannot know', () => {
  test('no publish timestamp falls back to the poll window, marked as a bound', () => {
    const e = { type: EVENT_TYPES.NEW_SKU, product: { sku: 'x' }, _prevPollAt: NOW - 6000 };
    assert.strictEqual(alertSpeed(e, NOW), '≤6.0s');
  });

  test('a RESTOCK uses the window, because published_at is not when it came back', () => {
    // The product was already live; what changed is availability. Quoting published_at here
    // would report days.
    const e = {
      type: EVENT_TYPES.RESTOCK,
      product: { sku: 'x', publishedAt: NOW - 86400000 },
      _prevPollAt: NOW - 9000,
    };
    assert.strictEqual(alertSpeed(e, NOW), '≤9.0s');
  });

  test('nothing to measure means the badge is omitted, not faked', () => {
    assert.strictEqual(alertSpeed({ type: EVENT_TYPES.NEW_SKU, product: { sku: 'x' } }, NOW), null);
  });
});

describe('alert speed: refuses to report nonsense', () => {
  test('a backdated listing is not dressed up as a detection time', () => {
    // First poll of a shop surfaces a whole catalogue of old products; those are not
    // 3-week-fast detections.
    assert.strictEqual(alertSpeed(newSku(NOW - 21 * 86400000), NOW), null);
  });

  test('a future timestamp (clock skew) is rejected rather than shown negative', () => {
    assert.strictEqual(alertSpeed(newSku(NOW + 5000), NOW), null);
  });

  test('the 10-minute ceiling applies to the window path too', () => {
    const e = { type: EVENT_TYPES.RESTOCK, product: { sku: 'x' }, _prevPollAt: NOW - 20 * 60000 };
    assert.strictEqual(alertSpeed(e, NOW), null);
  });
});

describe('alert speed: matches the configured cadence', () => {
  test('a 9s shop cycle produces a badge under 10s', () => {
    // interval 9000 + poll ~230ms, worst case the listing appeared just after the last poll.
    const e = { type: EVENT_TYPES.NEW_SKU, product: { sku: 'x' }, _prevPollAt: NOW - 9230 };
    const speed = alertSpeed(e, NOW);
    assert.strictEqual(speed, '≤9.2s');
    assert.ok(parseFloat(speed.replace('≤', '')) < 10, 'inside the 10s target');
  });

  test('exact latency beats the bound when Shopify gives us published_at', () => {
    const e = newSku(NOW - 4200, { _prevPollAt: NOW - 9230 });
    assert.strictEqual(alertSpeed(e, NOW), '4.2s', 'no "≤" — this one is exact');
  });
});
