# Single-tenant OmniArena image: builds the server and the web demo, then serves
# both from one Fastify process on one port (decision record #5 — self-hosted,
# one container per team, chat data never leaves adopter infra).

# ---- Builder: install every workspace dep and produce the production bundles ----
FROM node:22-bookworm AS builder
WORKDIR /app

# Install dependencies first for better layer caching. Copy the lockfile and
# every workspace manifest so `npm ci` can resolve the workspace graph.
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY packages/react-sdk/package.json ./packages/react-sdk/
COPY web/package.json ./web/
RUN npm ci

COPY . .

# Builds in workspace order: server (tsc) -> react-sdk (tsc) -> web (vite).
RUN npm run build

# tsc does not copy .sql files, but runMigrations reads them relative to the
# compiled migrations.js — ship them alongside dist so `node dist/db/migrate.js`
# finds them at runtime.
RUN cp -r server/src/db/migrations server/dist/db/migrations

# Drop dev dependencies so only runtime deps travel to the final image.
RUN npm prune --omit=dev

# ---- Runtime: slim image with just Node, the built bundles, and prod deps ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/server ./server
COPY --from=builder /app/web/dist ./web/dist
COPY docker/entrypoint.sh ./docker/entrypoint.sh

# API and the co-served web app share this port.
EXPOSE 3001

ENTRYPOINT ["./docker/entrypoint.sh"]
