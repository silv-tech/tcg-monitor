const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');
const logger = require('../monitoring/logger');
const { sleep } = require('./helpers');

const DEFAULT_HEADERS = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-CA,en-US;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
};

const UA_LIST = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
];

function randomUA() {
  return UA_LIST[Math.floor(Math.random() * UA_LIST.length)];
}

async function httpGet(url, opts = {}) {
  const {
    headers = {},
    proxyUrl = null,
    maxRetries = 3,
    retryDelayMs = 2000,
    timeoutMs = 15000,
    json = false,
  } = opts;

  const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        headers: {
          ...DEFAULT_HEADERS,
          'User-Agent': randomUA(),
          ...headers,
        },
        agent,
        signal: controller.signal,
        redirect: 'follow',
      });

      clearTimeout(timer);

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('retry-after') || '5') * 1000;
        logger.warn(`Rate limited on ${url}, waiting ${retryAfter}ms`);
        await sleep(retryAfter);
        continue;
      }

      if (res.status === 403 || res.status === 503) {
        logger.warn(`Blocked (${res.status}) on ${url}, attempt ${attempt}/${maxRetries}`);
        if (attempt < maxRetries) {
          await sleep(retryDelayMs * attempt);
          continue;
        }
        throw new Error(`Blocked after ${maxRetries} attempts: ${res.status}`);
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }

      return json ? await res.json() : await res.text();
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        logger.warn(`Timeout on ${url}, attempt ${attempt}/${maxRetries}`);
      } else if (attempt === maxRetries) {
        throw err;
      } else {
        logger.warn(`HTTP error on ${url}: ${err.message}, attempt ${attempt}/${maxRetries}`);
      }
      if (attempt < maxRetries) await sleep(retryDelayMs * attempt);
    }
  }
  throw new Error(`Failed after ${maxRetries} attempts: ${url}`);
}

module.exports = { httpGet, randomUA };
