# Backup & Restore

Two stores hold all state: **PostgreSQL** (`policytracker` schema — metadata, users, audit, attestations) and **S3/MinIO** (document bytes + renditions). Back up both; they must be restored to a consistent point.

## PostgreSQL

Back up only the app schema (keeps dumps small and portable):

```bash
pg_dump "$DATABASE_URL" --schema=policytracker --no-owner --no-privileges -Fc -f policytracker-$(date +%F).dump
```

Restore:

```bash
pg_restore --clean --if-exists --no-owner -d "$TARGET_DATABASE_URL" policytracker-YYYY-MM-DD.dump
```

Notes:
- Audit events and attestations are compliance evidence — never prune them in a way that breaks the chain; prefer archival over deletion.
- After restore, run `npx prisma migrate deploy` to reconcile any newer migrations.

## S3 / MinIO

Documents are immutable per version and the bucket has versioning on. Mirror the whole bucket:

```bash
# AWS
aws s3 sync s3://policymanager-docs ./s3-backup-$(date +%F) --exact-timestamps
# MinIO
mc mirror --preserve local/policymanager-docs ./s3-backup-$(date +%F)
```

Restore with the reverse `sync`/`mirror` into the target bucket. Because DB rows reference `s3Key` (+ `s3VersionId`), restore the bucket to the **same or newer** point than the DB dump so every referenced object exists.

## Consistency

1. Snapshot the DB first, then the bucket (bucket-newer-than-DB is safe; DB-newer-than-bucket can dangle a version row).
2. Verify after restore: log in, open a document, download a version (presigned URL resolves), export a cover page, and confirm `select count(*) from policytracker."DocumentVersion"` matches expectations.
