/**
 * index.js cannot be required from a test — main() runs on load — so nothing covers it, and a
 * moved constant took production down on 2026-09-09 for about two and a half minutes:
 *
 *   ReferenceError: SHOP_TIERS is not defined  at main (src/index.js:225)
 *
 * The cadence rule had been extracted to core/shop-tiers.js and one reference survived, in the
 * boot summary log. `node --check` passes — it is a syntax check, and an undefined identifier
 * is a RUNTIME error — and the pre-push grep looked for `SHOP_TIERS[`, which does not match
 * `Object.entries(SHOP_TIERS)`. The container then crash-looped on every start.
 *
 * This scans the entrypoint for SCREAMING_CASE identifiers it uses but never declares or
 * imports: exactly the shape of a constant left behind by a refactor.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ENTRY = path.join(__dirname, '../src/index.js');

// Legitimately undeclared in the file.
const ALLOWED = new Set([
  'JSON', 'Math', 'Object', 'Array', 'Number', 'String', 'Boolean', 'Promise',
  'Set', 'Map', 'Date', 'Error', 'RegExp', 'Symbol', 'Infinity', 'NaN', 'URL',
]);

const CONST_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;
const FUNC_RE = /\bfunction\s+([A-Za-z_$][\w$]*)/g;
const CLASS_RE = /\bclass\s+([A-Za-z_$][\w$]*)/g;
const DESTRUCTURE_RE = /\b(?:const|let|var)\s*\{([^}]*)\}/g;
// Not preceded by a dot, so `process.env.SHOPIFY_RATE` reads as a property access rather than
// a free identifier. A constant left behind by a refactor is never a property.
const SCREAMING_RE = /(?<![.\w$])([A-Z][A-Z0-9_]{2,})\b/g;

function declaredNames(code) {
  const names = new Set();
  for (const m of code.matchAll(CONST_RE)) names.add(m[1]);
  for (const m of code.matchAll(FUNC_RE)) names.add(m[1]);
  for (const m of code.matchAll(CLASS_RE)) names.add(m[1]);
  for (const m of code.matchAll(DESTRUCTURE_RE)) {
    for (const part of m[1].split(',')) {
      const name = part.split(':').pop().trim().replace(/=.*$/, '').trim();
      if (name) names.add(name);
    }
  }
  return names;
}

/**
 * Remove comments and string/template bodies so prose cannot create false positives.
 *
 * Template literals NEST — `a ${x ? `b FAILED` : ''} c` — so one pass leaves the outer body
 * exposed and its words read as identifiers. Collapse repeatedly until stable.
 */
function stripNonCode(src) {
  // Walked character by character rather than by regex. Regexes cannot do this: template
  // literals nest (`a ${x ? `b FAILED` : ''} c`), so a `[^`]*` pass mismatches its delimiters
  // and leaves prose exposed — which is how the word FAILED, inside a log message, read as an
  // undeclared constant. Depth tracking through ${ } is the whole point.
  let out = '';
  let i = 0;
  const n = src.length;
  let tplDepth = 0;          // how many nested template literals we are inside
  const exprStack = [];      // brace depth at which each ${ } expression opened

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    if (tplDepth === 0) {
      if (c === '/' && c2 === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; out += ' '; continue; }
      if (c === '/' && c2 === '/') { const e = src.indexOf('\n', i); i = e < 0 ? n : e; out += ' '; continue; }
      if (c === "'" || c === '"') {
        const q = c; i++;
        while (i < n && src[i] !== q) { if (src[i] === '\\') i++; i++; }
        i++; out += '""'; continue;
      }
    }

    if (c === '`') { tplDepth += tplDepth > 0 ? -1 : 1; out += '``'; i++; continue; }

    if (tplDepth > 0) {
      // Code inside ${ ... } is real code and must be kept.
      if (c === '$' && c2 === '{') { exprStack.push(tplDepth); tplDepth = 0; out += ' '; i += 2; continue; }
      i++; out += ' '; continue;   // literal template text — discard
    }
    if (c === '}' && exprStack.length) { tplDepth = exprStack.pop(); out += ' '; i++; continue; }

    out += c; i++;
  }
  return out;
}

function undeclaredConstants(src) {
  const code = stripNonCode(src);
  const declared = declaredNames(code);
  const used = new Set();
  for (const m of code.matchAll(SCREAMING_RE)) used.add(m[1]);
  return [...used].filter((n) => !declared.has(n)
    && !ALLOWED.has(n)
    && typeof globalThis[n] === 'undefined');
}

describe('entrypoint: no identifier left behind by a refactor', () => {
  test('every SCREAMING_CASE constant index.js uses is declared or imported', () => {
    const missing = undeclaredConstants(fs.readFileSync(ENTRY, 'utf8'));
    assert.deepStrictEqual(missing, [],
      `src/index.js references undeclared constant(s): ${missing.join(', ')} — a constant left `
      + 'behind by a refactor crash-loops the container on boot, and no other test loads this file');
  });

  test('the scanner actually catches the regression that caused the outage', () => {
    const broken = 'const clamped = [];\nlogger.info(String(Object.entries(SHOP_TIERS).length));\n';
    assert.deepStrictEqual(undeclaredConstants(broken), ['SHOP_TIERS'],
      'a scanner that cannot catch the real case is worthless');
  });

  test('a properly imported constant is not flagged', () => {
    const ok = 'const { SHOP_TIERS } = require("./core/shop-tiers");\nuse(SHOP_TIERS);\n';
    assert.deepStrictEqual(undeclaredConstants(ok), []);
  });
});
