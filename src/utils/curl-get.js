/**
 * Fetch a URL by shelling out to curl.
 *
 * This exists for exactly one reason: EB Games' Cloudflare fingerprints the TLS/HTTP2 stack,
 * and curl's is the only one it accepts. Measured 2026-09-08 against the same URLs, from the
 * same address, within minutes of each other:
 *
 *   impit with a Chrome fingerprint   403      curl with a browser User-Agent   200
 *   node-fetch                        403      curl, listing page               200, 926KB, 27 products, 1.16s
 *   global fetch (undici)             403      curl, product image              200, image/jpeg, 151,517B
 *
 * Same IP, same headers, opposite outcomes — so this is not a User-Agent check and not IP
 * reputation. Spoofing Chrome's fingerprint is actively worse here than not spoofing anything:
 * impit claims to be Chrome and is refused, while curl claims to be curl and is served.
 *
 * It is also free and fast, which matters because the alternative was buying every EB Games
 * listing through ScraperAPI at ~14,400 credits a day.
 *
 * Deliberately NOT a general replacement for stealthGet. Every other retailer works through the
 * existing clients, several of them specifically BECAUSE of the Chrome fingerprint, and spawning
 * a process per request is a cost worth paying only where nothing else works.
 */

const { execFile } = require('child_process');
const logger = require('../monitoring/logger');

const CURL_BIN = process.env.CURL_BIN || 'curl';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// A page is ~930KB and an image ~150KB. The ceiling is generous but finite: without one, a
// hung transfer would pin a process for as long as the OS allowed.
const MAX_BUFFER = 32 * 1024 * 1024;

let available = null; // cached probe result — the binary does not appear mid-process

/** Is curl actually here? The container installs it, but a local dev box may not have it. */
function isAvailable() {
  return available !== false;
}

function markUnavailable(reason) {
  if (available !== false) logger.warn(`curl unavailable (${reason}) — falling back to the usual clients`);
  available = false;
}

/**
 * GET a URL through curl.
 *
 * @param {string} url
 * @param {{timeoutMs?:number, binary?:boolean, headers?:object}} opts
 * @returns {Promise<{status:number, body:Buffer|string}|null>} null when curl cannot be used
 */
function curlGet(url, opts = {}) {
  const { timeoutMs = 30000, binary = false, headers = {} } = opts;
  if (!isAvailable()) return Promise.resolve(null);

  const args = [
    '-sS',                        // quiet, but still report errors
    '--compressed',
    '-A', headers['User-Agent'] || DEFAULT_UA,
    '--max-time', String(Math.ceil(timeoutMs / 1000)),
    // Write the HTTP status after the body so one invocation yields both without a second call.
    '-w', '\\n%{http_code}',
    url,
  ];
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'user-agent') continue;
    args.push('-H', `${k}: ${v}`);
  }

  return new Promise((resolve) => {
    execFile(CURL_BIN, args, {
      timeout: timeoutMs + 5000,
      maxBuffer: MAX_BUFFER,
      encoding: 'buffer',           // never let Node decode: it corrupts image bytes
    }, (err, stdout, stderr) => {
      if (err && (err.code === 'ENOENT' || err.code === 'EACCES')) {
        markUnavailable(err.code);
        return resolve(null);
      }
      // curl reports the real reason on stderr ("SSL routines", "Connection reset by peer",
      // "Could not resolve host"). Discarding it turned every distinct network failure into the
      // same useless "no result", which cost a diagnosis cycle.
      const why = (stderr && stderr.length) ? stderr.toString('utf8').trim().slice(0, 200) : '';
      if (!stdout || stdout.length === 0) {
        return resolve({ status: 0, body: '', error: why || (err && err.message) || 'empty response' });
      }

      // Split the trailing "\n<status>" off the end.
      const nl = stdout.lastIndexOf(0x0a);
      if (nl === -1) return resolve(null);
      const status = parseInt(stdout.slice(nl + 1).toString('ascii'), 10);
      // curl still emits its write-out template when the transfer never happened — a DNS or
      // connect failure yields "000". That is not a response, and returning it as one would let
      // a caller treat a dead host as a real HTTP result instead of falling through.
      if (!Number.isFinite(status) || status < 100) {
        // curl emits its write-out template even when the transfer never completed, so "000"
        // means "no HTTP response happened" — the reason is on stderr, not in the status.
        return resolve({ status: 0, body: '', error: why || (err && err.message) || 'transfer failed' });
      }

      const bodyBuf = stdout.slice(0, nl);
      resolve({ status, body: binary ? bodyBuf : bodyBuf.toString('utf8') });
    });
  });
}

module.exports = { curlGet, isAvailable, DEFAULT_UA };
