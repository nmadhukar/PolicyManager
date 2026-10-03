# PolicyManager

Document management for a behavioral health clinic — policies & procedures, job descriptions, and IOP/PHP curriculums — with versioning, access control, audit, QC review scheduling, e-attestation, compliance cover pages, and a read-only integration API. Built for CARF / Joint Commission compliance.

See `PLAN.md` for the full design and `AGENTS.md` for the development constitution.

## Monorepo

- `apps/api` — NestJS + Prisma API (PostgreSQL schema `policytracker`).
- `apps/web` — React + Vite + Tailwind web app.
- `packages/shared` — shared TypeScript types/constants.
- `prisma/` — schema + migrations.
- `.ai/`, `AGENTS.md` — the vibe coding framework.

## Local development

```bash
cp .env.example .env
npm install
docker compose up -d postgres minio mailhog   # + gotenberg onlyoffice for Phase 3+
npm run prisma:generate
npm run prisma:migrate
npm run db:seed
npm run dev:api    # http://localhost:3000  (Swagger at /api/docs)
npm run dev:web    # http://localhost:5173
```

## Quality gates

MCP and Hermes: set `MCP_ENABLED=true` to expose authenticated tools at `/api/mcp`.
See [the integration guide](docs/api/mcp.md), [Hermes setup](docs/admin/mcp-hermes.md),
and [activation/verification](docs/runbooks/mcp.md). Public API credentials remain
read-only; user JWTs use existing RBAC for actions.

```bash
npm run typecheck
npm run lint
npm test           # coverage gate: >=80% changed business-behavior lines
npm run build
```
