# Skill: S3 Storage Safety

## Purpose

Keep document storage private, immutable, and auditable.

## Use When

- Uploading documents.
- Downloading documents.
- Generating presigned URLs.
- Creating storage admin behavior.
- Exporting cover-page PDFs.

## Procedure

1. Validate file type and size.
2. Compute checksum.
3. Determine version number.
4. Build deterministic S3 key.
5. Upload without overwriting prior versions.
6. Store S3 version ID where available.
7. Authorize before issuing presigned URL.
8. Use short TTL for presigned URL.
9. Write audit event.
10. Verify bucket is not public.

## Key Pattern

```text
{S3_PREFIX_DOCUMENTS}{documentId}/v{versionNumber}/{safeFileName}
```

## Production Guardrails

- Auto-create is acceptable for local MinIO.
- Production AWS bucket/KMS/public-access changes require explicit env flags.
- Destructive bucket/object operations are out of v1 unless separately approved.

## Output

- S3 key.
- Authorization check location.
- Presigned URL TTL.
- Audit event proof.
