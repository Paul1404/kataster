# syntax=docker/dockerfile:1

# 1. Build the app (all deps).
FROM oven/bun:1.3.14 AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# 2. Production-only dependencies.
FROM oven/bun:1.3.14 AS prod-deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# 3. Runtime image. Same image runs both the web app and the worker
#    (different start commands per Railway service).
FROM oven/bun:1.3.14 AS runner
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
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/server.ts ./server.ts
EXPOSE 3000
CMD ["bun", "run", "server.ts"]
