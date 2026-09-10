/**
 * Two scope fixes whose correctness lives entirely in WHERE they sit in the chain.
 *
 * 1. "BUNDLE DEAL" IS A SEALED FORM — CHECKED AFTER THE ACCESSORY VETO.
 *
 * Two genuine products, the most expensive rows in the catalogue, were dropped because bare
 * "Bundle Deal" appeared in no sealed-form list: kanzengames' "Mega Evolution Set 7 ME07 Bundle
 * Deal" and its Wave 2 variant, $399.95 each.
 *
 * The obvious fix — adding it to DEFINITE_SEALED — is wrong, and an earlier attempt proved it.
 * DEFINITE_SEALED returns true BEFORE the accessory veto runs (deliberately, so an
 * "ETB ... 9 packs & accessories" is not vetoed by the word "accessories"), so anything folded in
 * there inherits that bypass. A sleeves-and-deck-box set titled "Bundle Deal" would sail straight
 * through. Placed AFTER the veto, it cannot. The position IS the fix.
 *
 * 2. AN EVENT TICKET IS NOT A PRODUCT.
 *
 * These read as sealed product and passed every gate — the word "Sealed" is often right there in
 * the title. Measured across 86,709 stored rows: 11 were in scope, 8 in stock, $10-$60.
 *   gameshack    "One Piece Two Legends OP-08 Pre-Release Sealed Event Ticket September 8, 12:45 PM"
 *   kanzengames  "Pokemon TCG Event League Cup - Saturday November 28th 11:00AM"
 * Alerting one tells a customer to buy something that arrives as a seat at a table.
 *
 * The veto is PHRASES, not words. A bare "ticket" would reject a real "Golden Ticket Promo
 * Collection Box"; a bare "entry" or "seat" is worse. That distinction is pinned below.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { isInScopeName } = require('../src/utils/scope');

describe('the two real Bundle Deal products are recovered', () => {
  for (const name of [
    'Mega Evolution Set 7 ME07 Bundle Deal (Pre-Order) Limited 2 per account per household',
    'Mega Evolution Set 7 ME07 Bundle Deal Wave 2 (Pre-Order) Limited 2 per account per household',
  ]) {
    test(`"${name.slice(0, 44)}…" is in scope`, () => {
      assert.strictEqual(isInScopeName(name), true, '$399.95 each, and we were silently dropping them');
    });
  }
});

describe('an accessory bundle is NOT rescued by the same phrase', () => {
  // This is the regression an earlier attempt shipped. If any of these flips to true, the check
  // has been moved back above the accessory veto.
  for (const name of [
    'Pokemon Card Sleeves and Deck Box Bundle Deal',
    'Pokemon Playmat + Binder Bundle Deal',
    'Pokemon TCG Toploader and Sleeve Bundle Deal 100ct',
    'Pokemon Binder Bundle Deal - Ultra Pro',
  ]) {
    test(`"${name}" stays OUT`, () => {
      assert.strictEqual(isInScopeName(name), false,
        'folding this into DEFINITE_SEALED would admit it — the accessory veto must run first');
    });
  }

  test('a genuine sealed bundle deal and an accessory one are distinguished', () => {
    assert.strictEqual(isInScopeName('Pokemon Mega Evolution Bundle Deal'), true);
    assert.strictEqual(isInScopeName('Pokemon Mega Evolution Sleeves Bundle Deal'), false);
  });
});

describe('event tickets are rejected', () => {
  for (const name of [
    'One Piece Two Legends OP-08 Pre-Release Sealed Event Ticket September 8, 12:45 PM',
    'One Piece Sealed Battle 2024 Vol.2 Event Ticket August 10, 10:30 AM',
    'One Piece Kingdoms of Intrigue OP-04 Pre-Release Sealed Event Ticket',
    'Pokémon TCG Event League Challenge - Friday Oct 2nd @ 6:30 PM',
    'Pokémon TCG Event League Cup - Saturday November 28th 11:00AM',
  ]) {
    test(`"${name.slice(0, 48)}…" stays OUT`, () => {
      assert.strictEqual(isInScopeName(name), false, 'a seat at a table is not a sealed box');
    });
  }
});

describe('the ticket veto is phrase-based and does not over-reach', () => {
  test('a real product whose NAME contains "ticket" is still in scope', () => {
    assert.strictEqual(isInScopeName('Pokemon TCG Golden Ticket Promo Collection Box'), true,
      'a bare "ticket" veto would have rejected this');
  });

  test('ordinary sealed product is untouched', () => {
    for (const n of [
      'Pokemon TCG Scarlet & Violet Prismatic Evolutions Elite Trainer Box',
      'One Piece Card Game OP-09 Emperors in the New World Booster Box',
      'Pokemon TCG: Journey Together Booster Bundle',
    ]) {
      assert.strictEqual(isInScopeName(n), true, n);
    }
  });

  test('a "League Battle Deck" is not a league event', () => {
    // "league cup" and "league challenge" are vetoed; "league battle deck" is a real product line.
    assert.strictEqual(isInScopeName("Pokemon TCG Team Rocket's Mewtwo ex League Battle Deck"), true);
  });
});
