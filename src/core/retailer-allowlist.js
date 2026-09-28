/**
 * `RETAILERS_ONLY` — run just the named retailers, whatever the config says.
 *
 * This exists so a SECOND deployment of this repo can be a narrow one (e.g. Amazon alone, to
 * exercise the browser bridge in amazon-extension/) without forking the code or editing
 * retailers.json. Editing that file is the obvious move and is a trap: the edit lives on a
 * branch, and merging the branch would silently disable those retailers in production.
 *
 * Applied AFTER the Redis override merge, deliberately — so a stale `enabled:true` override in a
 * shared Redis cannot switch a retailer back on in a deployment meant to be narrow. It is a
 * BOOT-TIME gate, not a runtime lock: an operator PATCHing /api/retailers/:id can still enable
 * one while the process runs.
 */

const logger = require('../monitoring/logger');

/**
 * @param {Array<object>} retailers  config rows, Redis overrides already merged
 * @param {string} [raw]             defaults to process.env.RETAILERS_ONLY
 * @returns {Array<object>} the same rows, with every non-listed retailer forced `enabled:false`
 * @throws  when an id is not a known retailer — see below
 */
function applyRetailerAllowlist(retailers, raw = process.env.RETAILERS_ONLY) {
  const spec = String(raw || '').trim();
  if (!spec) return retailers;

  const wanted = new Set(spec.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  if (wanted.size === 0) return retailers;

  // An unrecognised id is FATAL rather than ignored. A typo would otherwise disable every
  // retailer and leave a process that boots cleanly, logs nothing unusual and monitors nothing
  // at all — the most expensive way for this to fail, because it looks like success.
  const known = new Set(retailers.map(r => String(r.id).toLowerCase()));
  const unknown = [...wanted].filter(id => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `RETAILERS_ONLY names unknown retailer(s): ${unknown.join(', ')}. `
      + `Known ids: ${[...known].sort().join(', ')}`,
    );
  }

  const out = retailers.map(r => (
    wanted.has(String(r.id).toLowerCase()) ? r : { ...r, enabled: false }
  ));

  // WARN, not info: a deployment running one retailer looks broken to anyone who does not know
  // this variable is set, so it has to be loud in the log they will actually read.
  logger.warn(
    `RETAILERS_ONLY=${spec} — this process runs ${wanted.size} retailer(s) only `
    + `(${[...wanted].join(', ')}); every other retailer is forced off regardless of `
    + 'retailers.json or its Redis override.',
  );
  return out;
}

module.exports = { applyRetailerAllowlist };
