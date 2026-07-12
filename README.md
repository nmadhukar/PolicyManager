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

```bash
npm run typecheck
npm run lint
npm test           # coverage gate: >=80% changed business-behavior lines
npm run build
```
