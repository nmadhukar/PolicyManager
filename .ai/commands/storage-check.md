# Command: /storage-check

## Purpose

Verify storage behavior is private, versioned, and auditable.

## Procedure

1. Confirm bucket is not public.
2. Confirm upload creates new object key.
3. Confirm old version remains available.
4. Confirm checksum is stored.
5. Confirm presigned URL requires authorization first.
6. Confirm URL TTL is short.
7. Confirm access writes audit event.
8. Confirm production auto-provisioning is gated.

## Pass Criteria

- No public bucket or object path.
- No overwrites of historical document versions.
- Audit event for upload/download/export.
- Destructive storage admin operations absent unless approved.

## Output

- Storage evidence.
- Audit evidence.
- Risks.
