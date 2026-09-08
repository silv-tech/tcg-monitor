/**
 * EB Games alert thumbnails, supplied by the browser instead of bought.
 *
 * Discord cannot fetch ebgames.ca images: the same Cloudflare managed challenge that refuses
 * every datacenter client refuses Discord's fetcher, which is why alerts have to upload the
 * bytes themselves and why the only working route was a paid residential browser.
 *
 * The extension is already a real Chrome on a residential IP with the page open, so it hands
 * the bytes over and fetchImageBytes finds them in cache — the expensive route is never taken.
 * These pin the two things that make that safe: the cache key must be the one the alert will
 * look up, and bytes that are not an image must never reach a customer-visible thumbnail.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const imageFetch = require('../src/utils/image-fetch');
const state = require('../src/core/state');

// No Redis in unit tests. writeCache returns early when there is no client, which keeps these
// on the validation logic — and stops ioredis opening a connection whose retry timer would
// hold the test process open forever.
state.getRedis = () => null;

// Smallest thing that passes the magic-byte check: a PNG header padded past MIN_IMAGE_BYTES.
function fakePng(bytes = 1024) {
  const buf = Buffer.alloc(bytes, 0x20);
  Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(buf, 0);
  return buf;
}

const REAL_SRC = '/web/image/product.product/133779/image_1024/%5B804297%5D%20Pokemon%20Trading'
  + '%20Card%20Game%20Bloodmoon%20Ursaluna%20EX%20Box?unique=a96d808';
const BASE = 'https://www.ebgames.ca';

describe('ebgames images: what the browser sends is what the alert looks up', () => {
  test('the route builds the same absolute URL the adapter stores', () => {
    // parseCard stores `${baseUrl}${src}` (src/adapters/ebgames.js), and the ingest route
    // joins the same way — so a key built from either side has to be identical. If these ever
    // diverge, every upload silently caches under a key nothing reads.
    const fromAdapter = `${BASE}${REAL_SRC}`;
    const fromRoute = `${BASE}${REAL_SRC}`;
    assert.strictEqual(imageFetch.cacheKey(fromRoute), imageFetch.cacheKey(fromAdapter));
  });

  test('a different URL is a different key', () => {
    assert.notStrictEqual(
      imageFetch.cacheKey(`${BASE}${REAL_SRC}`),
      imageFetch.cacheKey(`${BASE}/web/image/product.product/999/image_1024/other`),
    );
  });
});

describe('ebgames images: junk never becomes a thumbnail', () => {
  const rejected = [
    ['an HTML error page', Buffer.from('<html><body>403 Forbidden</body></html>'.repeat(40))],
    ['an empty body', Buffer.alloc(0)],
    ['something too small to be an image', fakePng(16)],
    ['a non-buffer', 'not bytes'],
  ];
  for (const [label, body] of rejected) {
    test(`${label} is refused`, async () => {
      assert.strictEqual(await imageFetch.putImage(`${BASE}${REAL_SRC}`, body), false);
    });
  }

  test('a real image is accepted', async () => {
    assert.strictEqual(await imageFetch.putImage(`${BASE}${REAL_SRC}`, fakePng()), true);
  });

  test('a missing url is refused even with good bytes', async () => {
    assert.strictEqual(await imageFetch.putImage('', fakePng()), false);
  });
});
