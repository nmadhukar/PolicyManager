# ADR 0001 — Technology Stack

Status: Accepted

## Context

PolicyManager is a greenfield document management system for a behavioral health clinic, with compliance (CARF / Joint Commission) requirements: versioning, access control, audit, review workflow, attestation, and an integration API.

## Decision

- Backend: NestJS + TypeScript, Prisma ORM, PostgreSQL.
- Database schema: dedicated `policytracker` schema (never `public`).
- Frontend: React + Vite + TypeScript + Tailwind CSS + TanStack Query.
- Monorepo: npm workspaces (`apps/api`, `apps/web`, `packages/shared`).
- Object storage: S3 (AWS in prod, MinIO locally), env-driven + self-provisioning.
- Auth: standalone RBAC core + pluggable OIDC/SSO (openid-client).
- Document conversion/editing: Gotenberg (PDF renditions), OnlyOffice (edit-in-browser), TipTap (native authoring).
- Email: Nodemailer SMTP with admin UI; MailHog locally.
- Deployment: Docker + Coolify-compatible artifacts.

## Consequences

- One shared stack with the existing EMR ecosystem eases maintenance.
- Prisma multiSchema keeps app objects isolated in `policytracker`.
- Heavy sidecars (OnlyOffice, Gotenberg) are only needed from Phase 3 onward.
