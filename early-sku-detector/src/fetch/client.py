"""
Async HTTP fetch client with proxy rotation, per-domain rate limiting,
exponential backoff with jitter, realistic headers, and circuit breaker.
"""
import asyncio
import hashlib
import logging
import random
import time
from typing import Optional

import httpx

from src.config import settings
from src.fetch.rate_limiter import DomainRateLimiter
from src.fetch.circuit_breaker import CircuitBreaker

logger = logging.getLogger(__name__)

# Realistic browser headers — rotated per request
USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
]


def _get_domain(url: str) -> str:
    return httpx.URL(url).host


class FetchClient:
    def __init__(self):
        self._rate_limiter = DomainRateLimiter(settings.request_rate_limit)
        self._circuit_breakers: dict[str, CircuitBreaker] = {}
        self._semaphore = asyncio.Semaphore(settings.max_concurrent_requests)
        self._request_count = 0
        self._proxy_urls = self._build_proxy_list()

    def _build_proxy_list(self) -> list[str]:
        proxies = []
        if settings.proxy_residential_us_url:
            proxies.append(settings.proxy_residential_us_url)
        if settings.proxy_residential_url:
            proxies.append(settings.proxy_residential_url)
        return proxies

    def _get_proxy(self) -> Optional[str]:
        if not self._proxy_urls:
            return None
        return random.choice(self._proxy_urls)

    def _get_circuit_breaker(self, domain: str) -> CircuitBreaker:
        if domain not in self._circuit_breakers:
            self._circuit_breakers[domain] = CircuitBreaker(
                failure_threshold=5,
                recovery_timeout=300,  # 5 min cooldown
            )
        return self._circuit_breakers[domain]

    def _build_headers(self, url: str) -> dict[str, str]:
        domain = _get_domain(url)
        ua = random.choice(USER_AGENTS)
        return {
            "User-Agent": ua,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Accept-Encoding": "gzip, deflate, br",
            "Connection": "keep-alive",
            "Referer": f"https://{domain}/",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "same-origin",
            "Upgrade-Insecure-Requests": "1",
        }

    async def get(
        self,
        url: str,
        *,
        max_retries: int = 3,
        timeout: Optional[int] = None,
        headers: Optional[dict] = None,
        follow_redirects: bool = True,
        accept_xml: bool = False,
    ) -> Optional[str]:
        """
        Fetch a URL with rate limiting, backoff, circuit breaker, and proxy rotation.
        Returns response text or None on failure.
        """
        domain = _get_domain(url)
        cb = self._get_circuit_breaker(domain)

        if cb.is_open:
            logger.debug(f"Circuit open for {domain}, skipping {url}")
            return None

        req_headers = self._build_headers(url)
        if accept_xml:
            req_headers["Accept"] = "application/xml, text/xml, */*"
        if headers:
            req_headers.update(headers)

        timeout_val = timeout or settings.request_timeout

        for attempt in range(max_retries):
            await self._rate_limiter.acquire(domain)
            async with self._semaphore:
                proxy = self._get_proxy()
                try:
                    async with httpx.AsyncClient(
                        proxy=proxy,
                        timeout=httpx.Timeout(timeout_val),
                        follow_redirects=follow_redirects,
                        http2=True,
                    ) as client:
                        self._request_count += 1
                        resp = await client.get(url, headers=req_headers)

                        if resp.status_code == 200:
                            cb.record_success()
                            logger.debug(f"OK {url} ({len(resp.text)} bytes, attempt {attempt + 1})")
                            return resp.text

                        if resp.status_code == 429:
                            retry_after = float(resp.headers.get("Retry-After", "5"))
                            logger.warning(f"Rate limited on {domain}, waiting {retry_after}s")
                            await asyncio.sleep(retry_after)
                            continue

                        if resp.status_code in (403, 503):
                            cb.record_failure()
                            logger.warning(f"{resp.status_code} on {url} (attempt {attempt + 1})")
                        else:
                            logger.warning(f"HTTP {resp.status_code} on {url}")

                except (httpx.TimeoutException, httpx.ConnectError, httpx.RemoteProtocolError) as e:
                    cb.record_failure()
                    logger.warning(f"Fetch error on {url}: {type(e).__name__}: {e} (attempt {attempt + 1})")

                # Exponential backoff with jitter
                if attempt < max_retries - 1:
                    base_delay = 2 ** attempt
                    jitter = random.uniform(0, base_delay)
                    await asyncio.sleep(base_delay + jitter)

        logger.error(f"All {max_retries} attempts failed for {url}")
        return None

    @property
    def total_requests(self) -> int:
        return self._request_count


# Singleton
fetch_client = FetchClient()
