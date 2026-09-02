"""Per-domain token bucket rate limiter."""
import asyncio
import time


class DomainRateLimiter:
    def __init__(self, rate: float):
        """rate = max requests per second per domain."""
        self._rate = rate
        self._interval = 1.0 / rate if rate > 0 else 0
        self._last_request: dict[str, float] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    def _get_lock(self, domain: str) -> asyncio.Lock:
        if domain not in self._locks:
            self._locks[domain] = asyncio.Lock()
        return self._locks[domain]

    async def acquire(self, domain: str):
        if self._interval <= 0:
            return

        lock = self._get_lock(domain)
        async with lock:
            now = time.monotonic()
            last = self._last_request.get(domain, 0)
            elapsed = now - last
            if elapsed < self._interval:
                await asyncio.sleep(self._interval - elapsed)
            self._last_request[domain] = time.monotonic()
