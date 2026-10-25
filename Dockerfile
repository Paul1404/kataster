# syntax=docker/dockerfile:1

# 1. Build the app (all deps).
FROM oven/bun:1.4.4 AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# 2. Production-only dependencies.
FROM oven/bun:1.4.4 AS prod-deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --omit=peer

# 3. Runtime image. Same image runs both the web app and the worker
#    (different start commands per Railway service).
FROM oven/bun:1.4.4 AS runtime-system
USER root
COPY scripts/prune-runtime-packages.sh /prune-runtime-packages.sh
RUN sh /prune-runtime-packages.sh && rm /prune-runtime-packages.sh

# Copy the pruned filesystem into a fresh layer so removed packages are not
# carried in hidden base-image layers. Preserve Bun's runtime configuration.
FROM scratch AS runner
COPY --from=runtime-system / /
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/bun-node-fallback-bin \
    BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
    BUN_INSTALL_BIN=/usr/local/bin
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
WORKDIR /app
ENV NODE_ENV=production
# Both services idle most of the time: trade a little GC frequency for a
# smaller heap. BUN_OPTIONS applies to every `bun` invocation in this image.
ENV BUN_OPTIONS=--smol
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/src ./src
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/server.ts ./server.ts
EXPOSE 3000
USER bun
CMD ["bun", "run", "server.ts"]
