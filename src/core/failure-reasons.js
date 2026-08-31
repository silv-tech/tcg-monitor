const FAILURE_REASONS = {
  HTTP_403: 'http_403',
  HTTP_404: 'http_404',
  HTTP_429: 'http_429',
  TIMEOUT: 'timeout',
  PROXY_ERROR: 'proxy_error',
  BOT_CHALLENGE: 'bot_challenge',
  PARSE_ERROR: 'parse_error',
  EMPTY_RESPONSE: 'empty_response',
  NO_MARKERS: 'no_markers',
  UNKNOWN: 'unknown',
};

function classifyError(err) {
  const msg = (err.message || '').toLowerCase();
  if (msg.includes('timeout') || msg.includes('timed out')) return FAILURE_REASONS.TIMEOUT;
  if (msg.includes('403')) return FAILURE_REASONS.HTTP_403;
  if (msg.includes('404')) return FAILURE_REASONS.HTTP_404;
  if (msg.includes('429') || msg.includes('rate limit')) return FAILURE_REASONS.HTTP_429;
  if (msg.includes('econnrefused') || msg.includes('proxy') || msg.includes('socket hang up')) return FAILURE_REASONS.PROXY_ERROR;
  if (msg.includes('captcha') || msg.includes('challenge') || msg.includes('blocked')) return FAILURE_REASONS.BOT_CHALLENGE;
  return FAILURE_REASONS.UNKNOWN;
}

module.exports = { FAILURE_REASONS, classifyError };
