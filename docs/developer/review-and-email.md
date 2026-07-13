# QC Review Scheduling & Email/SMTP (Phase 5)

How reviewer assignment, the daily review sweep, review sign-off, the compliance
summary, and the SMTP admin fit together. Covers backlog tickets
PM-0501..PM-0509.

## Data model (`policytracker` schema)

All models live in the `policytracker` schema (never `public`). Migration:
`prisma/migrations/*_review_and_smtp` — adds 0 objects to `public` (verify with the
query in `AGENTS.md` §3).

- **`ReviewAssignment`** — a reviewer on a document's QC cycle. Unique per
  `(documentId, reviewerId)` so assigning twice is idempotent. Many reviewers per
  document; the sweep falls back to the document **owner** when there are none.
- **`ReviewTask`** — a dated, assignee-scoped unit of review work. Fields:
  `documentId`, `versionId?` (the current version at generation time), `dueDate`
  (the document's `nextReviewDate`), `assignedToId`, `status`
  (`pending|in_progress|completed|overdue|cancelled`), `completedAt?`,
  `completedById?`, `notes?`. The **open** statuses are
  `pending|in_progress|overdue`; `completed|cancelled` are terminal.
- **`SmtpConfig`** — the **singleton** SMTP configuration (fixed id `default`).
  The password is stored ONLY as AES-256-GCM ciphertext in `passwordEncrypted` —
  never plaintext (AGENTS.md §8). When `enabled`, `MailService` prefers this over
  the `SMTP_*` env fallback.
- **`NotificationLog`** — an immutable record of every attempted send (review
  reminders, password resets, test emails…): `toEmail`, `toUserId?`, `subject`,
  `type`, `reviewTaskId?`, `status` (`sent|failed`), `error?`.

## SMTP password encryption (AGENTS.md §8)

`common/crypto.util.ts` provides `encryptSecret`/`decryptSecret` using
**AES-256-GCM** (confidentiality + integrity). The env `APP_ENCRYPTION_KEY` (any
string) is SHA-256-hashed into a 32-byte key. Payload format is `iv:tag:data`
(base64). A wrong key or any tampering fails the GCM auth tag → decryption throws.

- `SmtpService.updateConfig` encrypts a provided password before storage. Omitting
  `password` keeps the stored one; an empty string clears it. The plaintext is
  **never** written to the audit trail (only a `passwordChanged` boolean).
- `SmtpService.getConfig` returns a redacted view: `hasPassword` boolean only, never
  the password/ciphertext. `source` is `db` (a saved row exists) or `env`.
- **Rotating `APP_ENCRYPTION_KEY` invalidates the stored SMTP password** — re-enter
  it after a change.

## Effective-config selection (DB vs env)

`MailService.send` resolves the effective transport **per send**:

1. an **enabled** `SmtpConfig` row (password decrypted) wins;
2. otherwise the `SMTP_*` env fallback.

A failure reading/decrypting the DB row degrades to env so a broken saved config
never black-holes email. Every send (success or failure) writes a
`NotificationLog` row, itself best-effort. `send` **never throws** — email is a
best-effort side-channel.

## The daily sweep (`ReviewService.runReviewSweep`)

Clock-injected (`now` is a parameter) so the cron, the manual trigger, and tests
all drive it deterministically. `ReviewScheduler` (`@nestjs/schedule`,
`EVERY_DAY_AT_2AM`) is the only place a real clock enters — it just calls
`runReviewSweep(new Date())`.

For each **active** document (not deleted/archived/retired) with
`nextReviewDate <= now + leadTime` (default **14 days**) and **no open task**
(the idempotency guard — re-running never double-creates), the sweep:

1. resolves reviewers = assigned reviewers, else the owner;
2. creates one `ReviewTask` per reviewer (`review.task_created` audit, `system`
   source);
3. emails each reviewer (`sendReviewReminder`, best-effort, logged);
4. finally flips any still-open, past-due tasks to `overdue`.

Manual trigger: `POST /api/reviews/run-sweep` (review.manage; admin/test).

## Schedule setup & bulk scheduling

Single-document schedule edits use `PATCH /api/documents/:id/review-schedule`
(`review.manage`) with `reviewCadence` and `nextReviewDate`.

Bulk schedule edits use `POST /api/documents/bulk-review-schedule`
(`review.manage`). The request targets either:

- `documentIds`: explicit row selections from the library table; or
- `filters`: the current library filters, with paging/sorting/trash omitted.

The service resolves the full target set, enforces edit access on every document
before updating any row, caps one request at 500 documents, then writes
`document.updated` audit rows for each affected document with `bulk: true`
metadata. Non-`none` cadences require a next review date so the sweep has an
actual due date to work from.

## Review completion & cadence advance

`POST /api/reviews/:taskId/complete` (assignee **or** review.manage). Completes the
task and advances the document's `nextReviewDate` via `advanceReviewDate`
(`review-cadence.util.ts`):

- `quarterly` → now + 3 months, `annual` → now + 12 months (the review resets the
  clock from completion day);
- `none`/`custom` → **require** `newNextReviewDate` (400 otherwise);
- an explicit `newNextReviewDate` overrides for any cadence.

`review.completed` is audited. **Phase 6 seam:** an `Attestation` (reviewed/approved,
name+role+timestamp+IP) will be recorded here, linked via `reviewTaskId` — this is
the single completion entry point it will hook.

## Compliance summary

`GET /api/reviews/compliance-summary` (review.manage) counts in-force documents
(active, not archived/retired), split into **overdue** (`nextReviewDate < now`),
**due-soon** (within the lead window), and **current** (everything else, incl. no
date). `percentCurrent = round(current / total * 100)` (100 when there are no docs).

## API surface & RBAC

| Route | Permission |
| --- | --- |
| `PATCH /api/documents/:id/review-schedule` | `review.manage` |
| `POST /api/documents/bulk-review-schedule` | `review.manage` |
| `GET/POST /api/documents/:id/reviewers`, `DELETE .../:userId` | `review.manage` |
| `POST /api/reviews/run-sweep`, `GET /api/reviews/compliance-summary` | `review.manage` |
| `GET /api/reviews`, `GET /api/reviews/tasks/:id`, `POST /api/reviews/:taskId/complete` | authenticated; **service scopes non-managers to their own tasks** |
| `GET/PUT /api/smtp/config`, `POST /api/smtp/test`, `GET /api/smtp/notifications` | `smtp.manage` |

Server-side enforcement only — UI hiding is never the boundary (AGENTS.md §8).
Non-`review.manage` callers are **always** scoped to their own tasks server-side
regardless of query filters; completing/viewing another user's task is `403`.

Audit actions added: `review.assigned`, `review.task_created`, `review.completed`,
`smtp.config_changed`, `smtp.test_sent`.

## Web

- **`/reviews`** (nav, all authenticated users — anyone may be a reviewer): My
  Reviews with Overdue / Due-soon / Upcoming sections, a month calendar of due
  dates, a complete-review modal (notes + next date), and compliance report cards +
  a "Run sweep" button for `review.manage` holders.
- **`/admin/email`** (nav under Admin, `smtp.manage`): the SMTP config form
  (password write-only — shows set/not-set, never the value), a Send-Test-Email
  card, and the notification delivery log.
- **Document detail** gains a Reviewers panel (`review.manage`) to assign/unassign
  reviewers, show cadence + next review date, and edit the schedule.
- **Library** gains row selection plus a bulk review scheduler. It can apply a
  cadence/date to selected rows or to every document matching the current filters
  (category, tag, owner, status, due state, and date bounds).

## Tests

- Unit (clock-injected, mocked Prisma/mail/audit): `crypto.util.spec`,
  `review-cadence.util.spec`, `review.service.spec` (sweep idempotency/lead-time/
  overdue/per-reviewer, completion authz + advance, compliance counts, reviewer
  assign), `smtp.service.spec` (encrypt-at-rest, redaction, effective config),
  `mail.service.spec` (DB-vs-env selection, notification logging).
- e2e (`test/review-and-smtp.e2e-spec.ts`, live Postgres + MailHog): SMTP save →
  encrypted at rest + redacted GET → test email captured + logged → past-due
  quarterly doc + reviewer → sweep creates a task + reminder captured → complete
  advances ~3mo + audit → compliance consistency → 403/401 → schema proof.
