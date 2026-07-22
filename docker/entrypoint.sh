#!/bin/sh
# Container entrypoint: bring the schema up to date, seed the model lineup, then
# start the combined API + web server. Migrations and the seed are idempotent,
# so this is safe to run on every start/restart.
set -e

echo "[entrypoint] applying database migrations..."
node server/dist/db/migrate.js

echo "[entrypoint] seeding model lineup..."
node server/dist/db/seed.js

echo "[entrypoint] starting OmniArena (API + web) on port ${PORT:-3001}..."
exec node server/dist/server.js
