# syntax=docker/dockerfile:1
# SaaS Shield production image.
#
# node:sqlite needs Node 22.5+, so the base image is pinned to 22 LTS. Dependencies
# are installed with `npm ci --omit=dev` and the process runs as a non-root user.
# The SQLite file lives on a volume, so rebuilding or restarting the container
# never touches data.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_FILE=/app/data/saas-shield.db

WORKDIR /app

# tini forwards SIGTERM and reaps zombies, so graceful shutdown actually runs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && find /var/lib/apt/lists -mindepth 1 -delete

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY public ./public
COPY tools ./tools
COPY docs ./docs

# Non-root by design: the app only ever needs to write inside /app/data.
RUN groupadd --system --gid 10001 shield \
 && useradd --system --uid 10001 --gid shield --home /app shield \
 && mkdir -p /app/data \
 && chown shield:shield /app/data

USER shield:shield

# A fresh volume starts empty; no database is ever baked into the image.
VOLUME ["/app/data"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
