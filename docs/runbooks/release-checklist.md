# Release Checklist

Run before promoting a build to production.

## Quality gates (CI must be green)
- [ ] `npm run typecheck` clean (shared + api + web)
- [ ] `npm run lint` clean (`--max-warnings 0`)
- [ ] `npm test` green (api unit + web) with coverage ≥ 80% on changed business lines
- [ ] `npm run test:e2e` green (Postgres + MinIO + MailHog + Gotenberg)
- [ ] `npm run build` succeeds; Docker images build

## Data & schema
- [ ] Migrations reviewed; `prisma migrate deploy` applies cleanly to a copy of prod
- [ ] Schema-placement proof: 0 app objects in `public`, all in `policytracker`
- [ ] Backup taken (DB dump + S3 mirror) immediately before deploy

## Security
- [ ] Secrets set via env/secret store (JWT ×2, `APP_ENCRYPTION_KEY`, S3, SMTP, OnlyOffice) — none committed
- [ ] `APP_ENCRYPTION_KEY` + JWT secrets stable vs previous release
- [ ] S3 bucket private (block-public-access), SSE on, presigned URLs only
- [ ] CORS origin restricted to the web origin in production
- [ ] Admin default password changed after first login

## Functional smoke (post-deploy)
- [ ] `GET /health` ok; `/api/docs` loads; web `/healthz` ok
- [ ] Log in; upload + version a document; view (rendition) + download
- [ ] Create a review, complete it (sign-off), export cover page
- [ ] Distribute an acknowledgment; acknowledge it
- [ ] Public API: create a client, fetch a published doc + `/content` with the key
- [ ] Reminder email delivered (check SMTP/inbox)

## Rollback
- [ ] Previous image tags recorded; DB backup + S3 backup located and restorable
