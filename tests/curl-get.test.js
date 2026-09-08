/**
 * curl as a fetch strategy.
 *
 * It exists for one host. EB Games' Cloudflare fingerprints the TLS/HTTP2 stack, and curl's is
 * the only one it accepts — measured from a single address within minutes of each other:
 *
 *   impit, Chrome fingerprint  403        curl, listing page   200, 926KB, 27 products, ~1s
 *   node-fetch                 403        curl, product image  200, exactly 151,517 bytes
 *   global fetch (undici)      403
 *
 * Same IP, same headers, opposite outcomes. Spoofing Chrome is actively worse here than not
 * spoofing anything, which is the opposite of every other retailer in this system.
 *
 * The rule these tests exist to protect: binary must survive. ScraperAPI could reach the same
 * image but returned 271,691 bytes for a 151,517-byte JPEG — a lossy UTF-8 re-encoding that
 * latin1 could not recover — and it looked like success at every layer, including a 200 and an
 * image/jpeg content type. Anything that decodes a body to a string before it is asked to
 * reintroduces exactly that bug.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { curlGet, isAvailable, DEFAULT_UA } = require('../src/utils/curl-get');

describe('curl fetch strategy', () => {
  test('reports availability rather than throwing when curl is missing', () => {
    assert.strictEqual(typeof isAvailable(), 'boolean');
  });

  test('sends a browser User-Agent by default', () => {
    assert.match(DEFAULT_UA, /Chrome\/\d+/,
      'curl\'s own UA is refused; the TLS fingerprint is what passes, but the UA still has to look like a browser');
  });

  test('a bad hostname reports status 0 WITH the reason, rather than throwing', async () => {
    // Returning a bare null made every distinct network failure look identical in production —
    // a blocked TLS handshake, a reset connection and a missing binary all read as "no result",
    // which cost a whole diagnosis cycle. The status distinguishes it from a real HTTP response.
    const res = await curlGet('https://this-host-does-not-exist.invalid/x', { timeoutMs: 5000 });
    assert.ok(res, 'a transfer failure is still a result worth reporting');
    assert.strictEqual(res.status, 0, '0 means no HTTP response happened');
    assert.ok(res.error && res.error.length > 0, 'curl says why on stderr — do not discard it');
  });

  test('returns a string for text and a Buffer for binary', async (t) => {
    // Touches the network, so it skips rather than fails when there is none: a suite that goes
    // red offline teaches people to ignore red.
    // Skip on anything short of a real 200. curlGet now reports a failed transfer as
    // { status: 0 } rather than null, so a bare null-check no longer catches a network hiccup —
    // which is exactly how this test went flaky and failed a run it should have skipped.
    const res = await curlGet('https://www.ebgames.ca/robots.txt', { timeoutMs: 20000 });
    if (!res || res.status !== 200) return t.skip('curl unavailable or offline');
    assert.strictEqual(typeof res.body, 'string');
    assert.strictEqual(typeof res.status, 'number');

    const bin = await curlGet('https://www.ebgames.ca/robots.txt', { timeoutMs: 20000, binary: true });
    if (!bin || bin.status !== 200) return t.skip('offline between calls');
    assert.ok(Buffer.isBuffer(bin.body),
      'binary mode must not decode — decoding is what corrupted the image on the paid route');
  });
});
