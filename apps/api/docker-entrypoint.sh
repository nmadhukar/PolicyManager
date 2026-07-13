#!/bin/sh
set -e

# Apply pending migrations to the policytracker schema (idempotent).
echo "Running prisma migrate deploy..."
npx prisma migrate deploy

# Optional one-shot seed (roles/permissions/admin) when SEED_ON_START=true.
if [ "$SEED_ON_START" = "true" ]; then
  echo "Seeding baseline roles/permissions/admin..."
  node apps/api/dist/../../prisma/seed.js 2>/dev/null || npx ts-node prisma/seed.ts || true
fi

echo "Starting PolicyManager API..."
exec node apps/api/dist/main.js
