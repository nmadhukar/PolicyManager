# Compare, Evidence Binder, Search, And Notifications

This guide covers the feature set that adds policy redlines, compliance evidence exports, advanced saved search, and in-app/email notifications.

## Backend Modules

- `apps/api/src/documents/document-compare.*` compares two immutable versions from the same document and exports a PDF redline summary.
- `apps/api/src/evidence/*` builds ZIP or combined PDF evidence binders for a document.
- `apps/api/src/search/*` stores and runs saved library searches.
- `apps/api/src/notifications/*` creates in-app notifications, stores digest preferences, and sends digest emails.

All new persistence belongs to the `policytracker` PostgreSQL schema:

- `SavedSearch`
- `EvidenceBinderJob`
- `Notification`
- `NotificationPreference`
- `NotificationDelivery`

## Permissions

- `evidence.export` is required for binder exports.
- `saved_search.manage` is required to create or change global and role-scoped saved searches.
- `audit.read` is required when the binder includes audit-log evidence.
- Notification digest administration uses the existing SMTP administration permission.

Server-side authorization is mandatory. UI visibility is only an affordance.

## Compare Flow

`DocumentCompareService` verifies document access before reading extracted text. The comparison endpoint only compares versions that belong to the same document. Missing extracted text is returned as an unavailable comparison rather than attempting OCR or file parsing inline.

The diff utility is line-based and deterministic. It is intended for reviewer evidence and annual review workflows, not legal-grade word processing redlines. If word-level redline is added later, keep the current line diff as a fallback for unsupported formats.

Audit events:

- `version.compare_viewed`
- `version.compare_exported`

## Evidence Binder Flow

`EvidenceBinderService` creates an `EvidenceBinderJob` row for every export. Export options control which artifacts are included:

- policy PDF with generated cover page
- standalone cover page
- approval chain CSV
- acknowledgment roster CSV
- review history CSV
- revision history CSV
- audit log CSV

ZIP export writes each artifact separately. Combined PDF export starts with the policy PDF with cover page and appends generated appendix pages. Source document bytes are not mutated.

Audit event:

- `evidence_binder.exported`

## Saved Search Flow

Saved searches persist library filter JSON, sort, order, and scope. Private searches are only visible to the owner. Global searches are visible to all users. Role-scoped searches are visible when the user has at least one matching role.

The saved-search run endpoint reuses `DocumentQueryService`, so new library filters should be added there first and then exposed through saved search storage.

Audit events:

- `saved_search.created`
- `saved_search.updated`
- `saved_search.deleted`

## Notification Flow

Notifications are created from existing business workflows:

- review assigned
- acknowledgment due
- policy published
- comment resolved
- approval requested

Notifications include a document link only when the recipient remains authorized to see that document. If access is later removed, the API masks title, body, and link for the affected notification.

Digest email uses `MailService` and `NotificationPreference`. Digest delivery attempts are recorded in `NotificationDelivery`.

Audit events:

- `notification_preferences.updated`
- `notification_digest.sent`
- `notification_digest.failed`

## Maintenance Notes

- Keep new Prisma models under `@@schema("policytracker")`.
- Add new notification types to both Prisma enum `AppNotificationType` and shared labels in `packages/shared`.
- Add document filters in three places: shared type, API DTO/query service, and web library page.
- Do not include mutable audit data in binder exports without an audit event that records the export.
