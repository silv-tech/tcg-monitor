FROM node:20-slim

# Install system dependencies for Patchright/Chromium.
#
# ca-certificates is NOT optional. Without it curl fails every HTTPS request with
# "curl: (77) error setting certificate file" before a connection is even attempted, and the
# HEALTHCHECK below hides that completely because it calls plain HTTP on localhost — so curl
# passes every check while being unable to reach anything on the internet.
#
# EB Games depends on curl specifically: its Cloudflare fingerprints the TLS stack and refuses
# impit, node-fetch and undici alike while serving curl. This one package is the difference
# between that store being free and costing ~14,400 ScraperAPI credits a day.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Store browser binaries inside /app so the non-root user can access them
ENV PLAYWRIGHT_BROWSERS_PATH=/app/.playwright-browsers

# Cap glibc's malloc arenas. MEASURED 2026-09-18: this service's memory climbs in a straight line
# (~1.4 GB/h) to ~7.7 GB of its 8 GB limit and is SIGKILLed every ~5h — yet in 48h and ~9 kills
# there was not ONE "JavaScript heap out of memory". V8's heap is capped near ~4 GB here (no
# --max-old-space-size is set), so the growth is OUTSIDE the JS heap, in native memory.
#
# The only native code that runs every poll is impit: Rust on tokio (one worker per core — this
# container has 8), hyper and BoringSSL, linked as the `linux-x64-gnu` build against glibc with NO
# custom allocator (no mimalloc/jemalloc in the binary). glibc gives each allocating thread its own
# arena, up to 8 x cores = 64 here, and an arena keeps freed memory instead of returning it. That
# is the textbook shape of this graph, and capping arenas is the standard remedy.
#
# NOT PROVEN — this is the test as well as the attempted fix. If memory stays flat after deploy,
# it was arena fragmentation and this is the fix. If it still climbs, the leak is inside impit
# itself and this line is harmless. Either way src/monitoring/memory-watchdog.js restarts the
# process gracefully before the kill. Cost: threads may briefly contend for 2 shared arenas, which
# only matters under heavy parallel allocation — this service uses 0.01-0.15 of one core out of 8.
ENV MALLOC_ARENA_MAX=2

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Install Patchright Chromium browser binary
RUN npx patchright install chromium

COPY . .

# Run as non-root user for security
RUN groupadd --system app && useradd --system --gid app app && \
    chown -R app:app /app
USER app

EXPOSE 3500

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3500/api/health || exit 1

CMD ["node", "src/index.js"]
