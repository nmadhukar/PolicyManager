# Skill: S3 Service Pattern

## Purpose

Implement S3/MinIO storage behavior consistently.

## Use When

- Adding storage service.
- Adding upload/download/export behavior.
- Adding storage admin UI backend.

## Procedure

1. Read env-driven storage config.
2. Support MinIO locally and AWS/S3-compatible storage in production.
3. Gate auto-provisioning by environment.
4. Keep bucket private.
5. Generate deterministic versioned object keys.
6. Authorize before presigning.
7. Audit access.
8. Update storage docs and code comments for safety-critical logic.

## Required Companion Skill

Use `.ai/skills/s3-storage-safety.md`.
