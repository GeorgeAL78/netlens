# NetLens — a dashboard for UniFi networks (web UI + collector).
# Published as gjergjk/netlens (Docker Hub) and ghcr.io/georgeal78/netlens.

# --- build the web UI ---------------------------------------------------------------
FROM node:24-alpine AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY vite.config.js ./
COPY web ./web
RUN npm run build

# --- runtime ------------------------------------------------------------------------
FROM node:24-alpine
ARG VERSION=dev
LABEL org.opencontainers.image.title="NetLens" \
      org.opencontainers.image.description="A dashboard for UniFi networks" \
      org.opencontainers.image.source="https://github.com/GeorgeAL78/netlens" \
      org.opencontainers.image.licenses="GPL-3.0" \
      org.opencontainers.image.version="${VERSION}"
WORKDIR /app
ENV APP_VERSION=${VERSION}
ENV NODE_ENV=production \
    UNIFI_SERVER_MODE=1 \
    UNIFI_BIND=0.0.0.0 \
    UNIFI_PORT=3780 \
    UNIFI_DATABASE_DIR=/data \
    UNIFI_LOG_DIR=/data/logs
# No TZ here: Unraid passes the server's timezone to every container; elsewhere set TZ.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server ./server
COPY --from=web /app/dist ./dist
VOLUME /data
# 3780 = web UI. 5514 = optional syslog listener for ad-block stats (SIEM_PORT).
EXPOSE 3780 5514/tcp 5514/udp
HEALTHCHECK --interval=60s --timeout=5s --start-period=60s \
  CMD wget -qO- http://127.0.0.1:${UNIFI_PORT}/healthz >/dev/null || exit 1
CMD ["node", "server/index.js"]
