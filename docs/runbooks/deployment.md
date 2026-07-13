# Deployment (Docker / Coolify)

PolicyManager ships as two images (`apps/api`, `apps/web`) plus infrastructure: PostgreSQL, S3 (AWS or MinIO), Gotenberg, OnlyOffice, and SMTP.

## Images

- **API** — `apps/api/Dockerfile` (multi-stage Node 20). Entrypoint runs `prisma migrate deploy` (applies migrations to the `policytracker` schema) then starts NestJS on `:3000` from `dist/main.js`. The build compiles `@policymanager/shared` to JS first so the runtime never loads TypeScript.
- **Web** — `apps/web/Dockerfile` (Vite build → nginx). Build with `VITE_API_BASE_URL=__API_BASE_URL__`; the container entrypoint replaces that sentinel with the runtime `API_BASE_URL` env, so one image serves any environment. Health at `/healthz`.

## Required environment (production)

| Group | Vars |
|---|---|
| DB | `DATABASE_URL=postgresql://user:pass@host:5432/db?schema=policytracker` |
| Auth | `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` (long random, distinct), `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL` |
| Crypto | `APP_ENCRYPTION_KEY` (32+ random bytes — encrypts stored SMTP password) |
| S3 | `S3_ENDPOINT` (blank for AWS), `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, `S3_PREFIX_*`, `S3_SSE`, `S3_AUTO_CREATE` |
| Convert/Edit | `GOTENBERG_URL`, `ONLYOFFICE_URL`, `ONLYOFFICE_JWT_SECRET`, `ONLYOFFICE_API_INTERNAL_URL` (URL the OnlyOffice container uses to reach the API) |
| Email | `SMTP_*` (fallback if no DB SmtpConfig), `FRONTEND_URL` (for reset links) |
| Web | `API_BASE_URL` (runtime, public API origin) |

Secrets come from the platform secret store / env — never committed. `APP_ENCRYPTION_KEY` and the JWT secrets must be stable across restarts (rotating them invalidates sessions / makes the stored SMTP password undecryptable).

## Coolify notes (matches the existing fleet)

- Publish the API host port and route via the panel/HAProxy per the fleet pattern; the web image serves on `:80`.
- OnlyOffice must reach the API over a network-routable host (`ONLYOFFICE_API_INTERNAL_URL`) for document fetch + save callbacks; the API must be able to fetch the edited file back from the Docs server — front both behind one internal hostname if they are on separate networks.
- Pick flat hostnames under the wildcard cert (e.g. `policymanager.<domain>`, `policymanager-api.<domain>`).
- Health: API `GET /health`, web `GET /healthz`.

## First-deploy order

1. Provision PostgreSQL + create the database. The first migration creates the
   app-owned `policytracker` schema before creating any tables or enums.
2. Provision the S3 bucket (or let `S3_AUTO_CREATE=true` create it) and Gotenberg/OnlyOffice/SMTP. Auto-create enables versioning and attempts a public-access block. Always set explicit S3 credentials for production or private/VPC S3-compatible endpoints.
3. Deploy the API; confirm `/health` and `/api/docs`.
4. Seed baseline roles/permissions/admin once (one-off job against the prod `DATABASE_URL`): `npm run db:seed` from a checkout, or a Coolify one-off command. Idempotent.
5. Deploy the web with `API_BASE_URL` set to the public API origin.
6. Log in as the seeded admin (`admin@policymanager.local` / seed password) and immediately change the password.
