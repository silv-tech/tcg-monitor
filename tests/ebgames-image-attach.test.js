/**
 * EB Games product images in Discord alerts.
 *
 * A Discord embed thumbnail is a URL that Discord's own servers fetch. Amazon and Walmart image
 * CDNs serve that fetch, so their alerts show a picture. EB Games' images sit behind a Cloudflare
 * that 403s every datacenter fetcher — Discord's included — so an ebgames.ca thumbnail URL
 * renders as nothing. Verified 2026-09-08.
 *
 * The fix: download the bytes ourselves through the ScraperAPI channel we already pay for, and
 * upload them to Discord as an attachment. Two things had to be true for that to work:
 *
 *   1. ScraperAPI must return the image INTACT. The old scraperFetch always did response.text(),
 *      which decodes a JPEG as UTF-8 and replaces every invalid byte with U+FFFD — the exact
 *      "271KB blob for a 151KB JPEG" corruption we saw. binary:true must use arrayBuffer().
 *   2. Delivery must swap the un-fetchable remote thumbnail for a local attachment, without
 *      mutating a shared embed (the watchlist path sends one embed to two channels).
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { EmbedBuilder } = require('discord.js');

// scraper-api captures SCRAPER_API_KEY as a const at load, so this must be set before the
// require below. node --test runs each file in its own process, so this does not leak.
process.env.SCRAPER_API_KEY = process.env.SCRAPER_API_KEY || 'test-key';

const scraperApi = require('../src/utils/scraper-api');
const imageFetch = require('../src/utils/image-fetch');
const delivery = require('../src/discord/delivery');
const state = require('../src/core/state');

// A minimal but valid JPEG byte sequence: SOI marker FF D8 FF, then filler above the module's
// 512-byte floor so looksLikeImage accepts it.
function fakeJpeg(len = 1024) {
  const b = Buffer.alloc(len, 0x20);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xe0;
  return b;
}

describe('scraperFetch binary handling', () => {
  let realFetch; let realGetRedis; let captured;

  beforeEach(() => {
    realFetch = global.fetch;
    realGetRedis = state.getRedis;
    state.getRedis = () => null; // budget restore/persist degrade to no-op
    captured = {};
  });
  afterEach(() => {
    global.fetch = realFetch;
    state.getRedis = realGetRedis;
  });

  test('binary:true returns the exact bytes, uncorrupted', async () => {
    const jpeg = fakeJpeg(2000);
    global.fetch = async (url, opts) => {
      captured.url = url; captured.accept = opts.headers.Accept;
      return {
        ok: true, status: 200, statusText: 'OK',
        arrayBuffer: async () => jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.length),
        text: async () => jpeg.toString('utf8'), // what the OLD code did — corrupts
      };
    };
    const out = await scraperApi.scraperFetch('https://www.ebgames.ca/x.jpg', {
      binary: true, render: false, premium: false, retailerId: 'img-test-1', minIntervalMs: 0,
    });
    assert.ok(Buffer.isBuffer(out), 'binary fetch must return a Buffer');
    assert.strictEqual(out.length, jpeg.length, 'byte length must be preserved exactly');
    assert.ok(out.equals(jpeg), 'bytes must be identical — no UTF-8 round-trip');
  });

  test('binary:true asks for an image, not text/html', async () => {
    global.fetch = async (url, opts) => {
      captured.accept = opts.headers.Accept;
      return { ok: true, status: 200, statusText: 'OK', arrayBuffer: async () => fakeJpeg().buffer };
    };
    await scraperApi.scraperFetch('https://www.ebgames.ca/y.jpg', {
      binary: true, render: false, premium: false, retailerId: 'img-test-2', minIntervalMs: 0,
    });
    assert.match(captured.accept, /image\//, 'a binary request must not advertise text/html');
  });

  test('the old text() path demonstrably corrupts a JPEG (regression guard)', () => {
    const jpeg = fakeJpeg(2000);
    // This is precisely what response.text() did to the bytes: decode as UTF-8, re-encode.
    const throughText = Buffer.from(jpeg.toString('utf8'), 'utf8');
    assert.ok(!throughText.equals(jpeg), 'text() must corrupt — this is why binary:true exists');
    assert.ok(throughText.length > jpeg.length, 'U+FFFD replacement inflates the size');
  });
});

describe('image-fetch looksLikeImage', () => {
  test('accepts real image magic bytes', () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(600)]);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(600)]);
    assert.ok(imageFetch.looksLikeImage(jpeg), 'JPEG');
    assert.ok(imageFetch.looksLikeImage(png), 'PNG');
  });
  test('rejects an HTML challenge page and tiny/oversized blobs', () => {
    const html = Buffer.from('<!DOCTYPE html><html><head>'.padEnd(700, ' '));
    assert.ok(!imageFetch.looksLikeImage(html), 'HTML must never be attached as an image');
    assert.ok(!imageFetch.looksLikeImage(Buffer.from([0xff, 0xd8, 0xff])), 'below the size floor');
    assert.ok(!imageFetch.looksLikeImage('not a buffer'), 'non-buffer');
  });
});

describe('delivery.resolveThumbnail', () => {
  let realFetchBytes;
  beforeEach(() => { realFetchBytes = imageFetch.fetchImageBytes; });
  afterEach(() => { imageFetch.fetchImageBytes = realFetchBytes; });

  test('EB Games thumbnail becomes a local attachment, original embed untouched', async () => {
    imageFetch.fetchImageBytes = async () => fakeJpeg();
    const original = new EmbedBuilder().setThumbnail('https://www.ebgames.ca/web/image/1/x.jpg');
    const { embed, files } = await delivery.resolveThumbnail(original);
    assert.ok(files && files.length === 1, 'must attach one file');
    assert.strictEqual(embed.data.thumbnail.url, 'attachment://thumb.jpg', 'clone points at the attachment');
    assert.strictEqual(original.data.thumbnail.url, 'https://www.ebgames.ca/web/image/1/x.jpg',
      'the shared original must NOT be mutated — the watchlist sends it to two channels');
  });

  test('a fetchable host (Amazon) is left as a remote thumbnail, no attachment', async () => {
    let called = false;
    imageFetch.fetchImageBytes = async () => { called = true; return fakeJpeg(); };
    const original = new EmbedBuilder().setThumbnail('https://m.media-amazon.com/images/I/abc.jpg');
    const { embed, files } = await delivery.resolveThumbnail(original);
    assert.strictEqual(files, undefined, 'no attachment for a host Discord can fetch');
    assert.strictEqual(embed, original, 'embed returned unchanged');
    assert.strictEqual(called, false, 'must not spend a fetch on a host that works remotely');
  });

  test('when the image cannot be fetched, the alert still sends (graceful, no image)', async () => {
    imageFetch.fetchImageBytes = async () => null;
    const original = new EmbedBuilder().setThumbnail('https://www.ebgames.ca/web/image/1/x.jpg');
    const { embed, files } = await delivery.resolveThumbnail(original);
    assert.strictEqual(files, undefined, 'no file when fetch fails');
    assert.strictEqual(embed, original, 'falls back to the original embed — never blocks the alert');
  });

  test('an embed with no thumbnail is a no-op', async () => {
    const original = new EmbedBuilder().setTitle('no image');
    const { embed, files } = await delivery.resolveThumbnail(original);
    assert.strictEqual(files, undefined);
    assert.strictEqual(embed, original);
  });
});
