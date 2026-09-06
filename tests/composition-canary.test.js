/**
 * The composition canary exists for one failure mode: a store that keeps working while
 * quietly losing a whole game.
 *
 * On 2026-09-06 the string 'hat ' in the non-TCG list matched "Straw Hat Crew" and classified
 * One Piece starter decks and booster boxes as clothing. Product counts stayed plausible,
 * prices were fine, error counts were zero, and every health check read green. The only
 * symptom was drops we never alerted on — and a missed drop raises no error and generates no
 * support ticket. Nothing in the system could have reported it.
 *
 * These tests drive the real recorder, so they fail if the detection logic regresses.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const health = require('../src/monitoring/health');
const { recordComposition, getComposition } = health;

const BASELINE_POLLS = 20;
const MISSING_THRESHOLD = 10;
const MIN_SAMPLE = 10;

let seq = 0;
const freshId = () => 'test-shop-' + (++seq);

// A catalogue big enough to be judged (below MIN_SAMPLE a poll is treated as a partial read).
function catalogue({ pokemon = 0, onePiece = 0, filler = 0 }) {
  const out = {};
  let i = 0;
  for (let n = 0; n < pokemon; n++) out['p' + i++] = { name: `Pokemon TCG Booster Box ${n}` };
  for (let n = 0; n < onePiece; n++) out['o' + i++] = { name: `One Piece Card Game Booster Box ${n}` };
  for (let n = 0; n < filler; n++) out['f' + i++] = { name: `Filler Product ${n}` };
  return out;
}

describe('composition canary: the Straw Hat failure', () => {
  test('reports a game that vanished from a store that reliably carried it', () => {
    const id = freshId();
    // Normal operation: this store carries both games.
    for (let i = 0; i < BASELINE_POLLS; i++) {
      recordComposition(id, catalogue({ pokemon: 15, onePiece: 12 }));
    }
    assert.deepStrictEqual(getComposition()[id], undefined, 'nothing wrong yet');

    // The bug lands. Pokemon is untouched, One Piece silently classified as clothing.
    // Catalogue size stays plausible, so no other check reacts.
    for (let i = 0; i < MISSING_THRESHOLD; i++) {
      recordComposition(id, catalogue({ pokemon: 15, filler: 12 }));
    }

    const lost = getComposition()[id];
    assert.ok(lost, 'the disappearance must be reported');
    assert.strictEqual(lost.length, 1);
    assert.strictEqual(lost[0].game, 'one piece');
    assert.strictEqual(lost[0].typical, 12, 'reports what normal looked like');
  });

  test('recovers silently once the game comes back', () => {
    const id = freshId();
    for (let i = 0; i < BASELINE_POLLS; i++) recordComposition(id, catalogue({ pokemon: 15, onePiece: 12 }));
    for (let i = 0; i < MISSING_THRESHOLD; i++) recordComposition(id, catalogue({ pokemon: 15, filler: 12 }));
    assert.ok(getComposition()[id]);

    recordComposition(id, catalogue({ pokemon: 15, onePiece: 12 }));
    assert.strictEqual(getComposition()[id], undefined, 'clears as soon as it is back');
  });
});

describe('composition canary: it must not cry wolf', () => {
  test('a store that never carried a game is never reported for it', () => {
    // London Drugs genuinely sells no One Piece — verified against all 29,775 products in
    // its sitemap. A hardcoded "every store has both" rule would alert on it forever.
    const id = freshId();
    for (let i = 0; i < BASELINE_POLLS + MISSING_THRESHOLD * 3; i++) {
      recordComposition(id, catalogue({ pokemon: 26 }));
    }
    assert.strictEqual(getComposition()[id], undefined);
  });

  test('a brand new store is not judged before it has a baseline', () => {
    const id = freshId();
    // Seen a few times with One Piece, then it disappears — too early to call.
    for (let i = 0; i < 5; i++) recordComposition(id, catalogue({ pokemon: 15, onePiece: 12 }));
    for (let i = 0; i < MISSING_THRESHOLD * 2; i++) recordComposition(id, catalogue({ pokemon: 15, filler: 12 }));
    assert.strictEqual(getComposition()[id], undefined, 'needs a real baseline first');
  });

  test('one thin poll does not trigger it', () => {
    const id = freshId();
    for (let i = 0; i < BASELINE_POLLS; i++) recordComposition(id, catalogue({ pokemon: 15, onePiece: 12 }));
    recordComposition(id, catalogue({ pokemon: 15, filler: 12 }));
    assert.strictEqual(getComposition()[id], undefined, 'needs a sustained absence');
  });

  test('a partial read below the sample floor is ignored entirely', () => {
    const id = freshId();
    for (let i = 0; i < BASELINE_POLLS; i++) recordComposition(id, catalogue({ pokemon: 15, onePiece: 12 }));
    // A fast poll returning a handful of products must not read as "One Piece is gone".
    for (let i = 0; i < MISSING_THRESHOLD * 2; i++) {
      recordComposition(id, catalogue({ pokemon: MIN_SAMPLE - 5 }));
    }
    assert.strictEqual(getComposition()[id], undefined);
  });

  test('an empty or missing product map is ignored', () => {
    const id = freshId();
    for (let i = 0; i < BASELINE_POLLS; i++) recordComposition(id, catalogue({ pokemon: 15, onePiece: 12 }));
    for (let i = 0; i < MISSING_THRESHOLD * 2; i++) {
      recordComposition(id, {});
      recordComposition(id, null);
    }
    assert.strictEqual(getComposition()[id], undefined);
  });
});

describe('composition canary: what it reports', () => {
  test('both games can be reported missing at once', () => {
    const id = freshId();
    for (let i = 0; i < BASELINE_POLLS; i++) recordComposition(id, catalogue({ pokemon: 15, onePiece: 12 }));
    for (let i = 0; i < MISSING_THRESHOLD; i++) recordComposition(id, catalogue({ filler: 30 }));
    const lost = getComposition()[id].map((g) => g.game).sort();
    assert.deepStrictEqual(lost, ['one piece', 'pokemon']);
  });

  test('typical is a high-water mark, so a thin week cannot deflate "normal"', () => {
    const id = freshId();
    for (let i = 0; i < BASELINE_POLLS; i++) recordComposition(id, catalogue({ pokemon: 15, onePiece: 40 }));
    for (let i = 0; i < BASELINE_POLLS; i++) recordComposition(id, catalogue({ pokemon: 15, onePiece: 3 }));
    for (let i = 0; i < MISSING_THRESHOLD; i++) recordComposition(id, catalogue({ pokemon: 15, filler: 12 }));
    assert.strictEqual(getComposition()[id][0].typical, 40);
  });

  test('accented Pokémon counts the same as Pokemon', () => {
    const id = freshId();
    const accented = {};
    for (let n = 0; n < 15; n++) accented['a' + n] = { name: `Pokémon TCG Booster Box ${n}` };
    for (let i = 0; i < BASELINE_POLLS; i++) recordComposition(id, accented);
    for (let i = 0; i < MISSING_THRESHOLD * 2; i++) recordComposition(id, catalogue({ filler: 20 }));
    const lost = getComposition()[id];
    assert.ok(lost.some((g) => g.game === 'pokemon'), 'the accented spelling must count');
  });
});
