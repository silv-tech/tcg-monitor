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
    libcups2 xvfb \
    && rm -rf /var/lib/apt/lists/*

# libcups2 and xvfb are what make Pokemon Center readable AT ALL, and neither is optional.
#
# Measured 2026-09-13 from this container: Patchright headless, full Chromium --headless=new, and
# plain stealth GETs all get an Imperva interstitial on pokemoncenter.com that escalates to
# hCaptcha and never clears -- via residential proxy, datacenter proxy and direct alike. The same
# container gets clean 200s on /robots.txt and /sitemaps/*, so it was never an IP ban: HEADLESS is
# the signal being fingerprinted.
#
# A HEADED browser under a virtual display renders the real catalogue -- prices, SOLD OUT badges
# and all. That needs Xvfb for the display, and libcups2 because the full Chromium binary (as
# opposed to the headless shell) will not even launch without it:
#
#   ldd chrome | grep 'not found'  ->  libcups.so.2 => not found
#
# Removing either package does not degrade Pokemon Center gracefully; it takes the store's stock
# detection to zero, silently, because the adapter's safety rule reports unreadable tiles as
# UNKNOWN rather than guessing.

WORKDIR /app

# Store browser binaries inside /app so the non-root user can access them
ENV PLAYWRIGHT_BROWSERS_PATH=/app/.playwright-browsers

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
