# E2B template "scoop-crawler": Node + Playwright + Chromium and the job server.
# Build with `npm run template:build` (E2B CLI, E2B_API_KEY in the environment).
# The image's Playwright version must match package.json.
FROM mcr.microsoft.com/playwright:v1.64.0-noble

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json /home/user/crawler/
RUN cd /home/user/crawler && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev
COPY lib.js crawl.js server.js cli.js /home/user/crawler/
COPY vendor /home/user/crawler/vendor
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
