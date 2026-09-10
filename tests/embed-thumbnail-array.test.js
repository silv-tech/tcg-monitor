/**
 * An array thumbnail must never reach discord.js.
 *
 * Pokemon Center's product JSON-LD ships `image` as an ARRAY of five-plus gallery URLs, and the
 * adapter stored it raw. discord.js 14 answers `setThumbnail([...])` with "Received one or more
 * errors" — a THROW, and it is raised inside buildAlertEmbed.
 *
 * Why that is expensive rather than merely ugly: the throw happens AFTER poll-adapter has
 * written the new stock state to Redis. events.js raises RESTOCK on stored-false -> reported-true,
 * so once the store says true the transition cannot be detected again. markSent never runs, the
 * send is never retried, and the alert is gone — surfacing only as "Failed to send alert".
 *
 * Measured 2026-09-11 against the live store: 649 of 805 Pokemon Center rows hold an array and
 * NONE holds a string. Pokemon Center has 0 products in stock while Bright Data is suspended,
 * which is the only reason this has never fired; the first restock after that transport is
 * restored would have hit ~81% of the catalogue.
 *
 * The guard is deliberately in TWO places. The parser fix only helps rows written from now on —
 * the 649 already in Redis replay on every poll until each is re-checked, so buildAlertEmbed
 * itself has to be safe.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { EmbedBuilder } = require('discord.js');
const { buildAlertEmbed } = require('../src/discord/embeds');

const GALLERY = [
  'https://www.pokemoncenter.com/images/DAMRoot/High/10000/P9555_290-85982_01.jpg',
  'https://www.pokemoncenter.com/images/DAMRoot/High/10000/P9555_290-85982_02.jpg',
];

const product = (over = {}) => ({
  sku: '290-85982',
  name: 'Pokemon TCG: Prismatic Evolutions Elite Trainer Box',
  price: 59.99,
  currency: 'CAD',
  url: 'https://www.pokemoncenter.com/en-ca/product/290-85982/prismatic-evolutions-etb',
  inStock: true,
  retailer: 'Pokemon Center',
  retailerId: 'pokemoncenter',
  category: 'pokemon',
  ...over,
});

const event = (p) => ({ type: 'RESTOCK', product: p, detail: 'Back in stock', oldValue: false, newValue: true });

describe('the underlying discord.js behaviour this guards against', () => {
  test('setThumbnail rejects an array', () => {
    assert.throws(() => new EmbedBuilder().setThumbnail(GALLERY),
      'if this ever stops throwing, the guard may be relaxed — until then it is load-bearing');
  });

  test('setThumbnail accepts a string', () => {
    assert.doesNotThrow(() => new EmbedBuilder().setThumbnail(GALLERY[0]));
  });
});

describe('buildAlertEmbed survives every shape the stores actually store', () => {
  test('an ARRAY image does not throw, and the first URL is used', () => {
    let out;
    assert.doesNotThrow(() => { out = buildAlertEmbed(event(product({ image: GALLERY }))); },
      'a throw here loses the alert permanently — the stock state is already written');
    assert.strictEqual(out.embed.data.thumbnail.url, GALLERY[0], 'the primary product shot');
  });

  test('a plain string image still works', () => {
    const out = buildAlertEmbed(event(product({ image: GALLERY[1] })));
    assert.strictEqual(out.embed.data.thumbnail.url, GALLERY[1]);
  });

  test('an EMPTY array is treated as no image rather than as undefined', () => {
    let out;
    assert.doesNotThrow(() => { out = buildAlertEmbed(event(product({ image: [] }))); });
    assert.strictEqual(out.embed.data.thumbnail, undefined);
  });

  test('a missing image is still fine', () => {
    let out;
    assert.doesNotThrow(() => { out = buildAlertEmbed(event(product({ image: '' }))); });
    assert.strictEqual(out.embed.data.thumbnail, undefined);
  });

  test('a non-string, non-array image is ignored instead of thrown on', () => {
    for (const junk of [123, {}, null, true]) {
      let out;
      assert.doesNotThrow(() => { out = buildAlertEmbed(event(product({ image: junk }))); },
        `image=${JSON.stringify(junk)} must not throw`);
      assert.strictEqual(out.embed.data.thumbnail, undefined);
    }
  });
});
