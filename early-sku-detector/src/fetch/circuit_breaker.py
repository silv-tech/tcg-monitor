"""Circuit breaker to avoid hammering failing domains."""
import time


class CircuitBreaker:
    def __init__(self, failure_threshold: int = 5, recovery_timeout: float = 300):
        self._failure_threshold = failure_threshold
        self._recovery_timeout = recovery_timeout
        self._failure_count = 0
        self._last_failure_time = 0.0
        self._state = "closed"  # closed = healthy, open = failing

    @property
    def is_open(self) -> bool:
        if self._state == "open":
            if time.monotonic() - self._last_failure_time >= self._recovery_timeout:
                self._state = "half-open"
                return False
            return True
        return False

    def record_success(self):
        self._failure_count = 0
        self._state = "closed"

    def record_failure(self):
        self._failure_count += 1
        self._last_failure_time = time.monotonic()
        if self._failure_count >= self._failure_threshold:
            self._state = "open"
