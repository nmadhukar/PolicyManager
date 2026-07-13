#!/bin/sh
set -e

# Apply pending migrations to the policytracker schema (idempotent).
echo "Running prisma migrate deploy..."
npx prisma migrate deploy

# First-deploy seeding is a one-off operation run as a separate job
# (e.g. `npm run db:seed` from a dev checkout, or a Coolify one-off command),
# not baked into every container start. See docs/runbooks/deployment.md.

echo "Starting PolicyManager API..."
exec node apps/api/dist/main.js
