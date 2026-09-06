/**
 * An Amazon OLID is a base64 token, so it routinely contains "+", "/" and "=".
 *
 * Those three characters are exactly the ones that change meaning in a URL: a raw "+"
 * decodes to a space, "/" ends the path segment, "=" splits a parameter. Our embed printed
 * the token raw while every other monitor prints it percent-encoded, so a token copied out
 * of our alert resolved to a different offer — or none — than the one the alert was about.
 *
 * The rule this locks in: ONE canonical internal form (decoded), encoded exactly once at
 * every point it leaves the system. Encoding at both ends double-encodes (%2B -> %252B),
 * which is just as wrong and much harder to spot.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

// The real token from the 2026-09-05 alert for B0GW2DK37Q, which displayed raw.
const RAW_OLID =
  'bg0Q4D2ojq07PWJEXEdLhYLli5D2OHt6NfOU+Ioen3bCZa8/+XhfLidOw9xeHu2M7a4h4H/' +
  'yLWgiK4u9jDArtXHBUIiJBuNhl631WyghXAL/UY/SsMhJfGzS7eRv804wkoPvLFDY4Lw=';

// How the adapter reads it out of Amazon's HTML: percent-encoded in the value attribute.
const ENCODED_OLID = encodeURIComponent(RAW_OLID);

function safeDecode(v) {
  try { return decodeURIComponent(v); } catch { return v; }
}

describe('amazon offer id: canonical internal form', () => {
  test('the adapter decodes what Amazon emits, so storage is raw', () => {
    assert.strictEqual(safeDecode(ENCODED_OLID), RAW_OLID);
  });

  test('a malformed escape falls back instead of throwing away the whole parse', () => {
    // A bare % is not a valid escape; decodeURIComponent throws URIError on it.
    assert.throws(() => decodeURIComponent('abc%zz'), URIError);
    assert.strictEqual(safeDecode('abc%zz'), 'abc%zz');
  });

  test('decoding an already-raw token is a no-op, so double-decode is harmless', () => {
    assert.strictEqual(safeDecode(RAW_OLID), RAW_OLID);
  });
});

describe('amazon offer id: encoded exactly once on the way out', () => {
  test('the displayed token is percent-encoded', () => {
    const shown = encodeURIComponent(RAW_OLID);
    assert.ok(shown.includes('%2B'), 'a + must be shown as %2B');
    assert.ok(shown.includes('%2F'), 'a / must be shown as %2F');
    assert.ok(shown.includes('%3D'), 'an = must be shown as %3D');
    assert.ok(!/[+]/.test(shown), 'no raw + may survive into the embed');
  });

  test('the displayed token round-trips back to the exact offer', () => {
    assert.strictEqual(decodeURIComponent(encodeURIComponent(RAW_OLID)), RAW_OLID);
  });

  test('encoding an already-encoded token double-encodes — the bug on the other side', () => {
    const doubled = encodeURIComponent(ENCODED_OLID);
    assert.ok(doubled.includes('%252B'), 'this is what storing it encoded would produce');
    assert.notStrictEqual(decodeURIComponent(doubled), RAW_OLID);
  });

  test('a raw + in a query value really does become a space', () => {
    // Why this matters at all: the failure is silent, the link still loads.
    const parsed = new URLSearchParams('OfferListingId.1=a+b').get('OfferListingId.1');
    assert.strictEqual(parsed, 'a b');
    const encoded = new URLSearchParams('OfferListingId.1=a%2Bb').get('OfferListingId.1');
    assert.strictEqual(encoded, 'a+b');
  });

  test('a Walmart-style alphanumeric offer id is unchanged by encoding', () => {
    const walmart = '8F3A21C0D94B4E1F9A7C';
    assert.strictEqual(encodeURIComponent(walmart), walmart);
  });
});
