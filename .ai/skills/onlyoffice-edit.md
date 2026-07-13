# Skill: OnlyOffice Edit-In-Browser

## Purpose

Edit Office documents (docx, xlsx, pptx) in the browser via a self-hosted OnlyOffice Docs server, and persist edits as new immutable versions.

## Use When

- Adding in-place editing of Word/Excel/PowerPoint documents.
- Adding a native rich-text authoring flow (pair with TipTap for app-authored docs).

## Procedure

1. Require `document.write` permission and document/category ACL before opening an editor session.
2. Issue a short-lived, signed editor config so OnlyOffice loads the current version's source from a scoped URL, not a public bucket.
3. On editor save, receive the OnlyOffice save callback and validate its authenticity with the JWT-signed callback secret.
4. Require the callback token to carry the editor user and re-check that user's live `document.write` plus document/category access before downloading edited bytes.
5. Store the saved bytes as a NEW immutable `DocumentVersion`: increment version, new S3 object, new checksum, and never overwrite the prior version's bytes.
6. Regenerate the PDF rendition for the new version. See `.ai/skills/document-rendition-viewer.md`.
7. Write an audit event for the edit/version creation, capturing user, version, and timestamp.
8. Re-open any pending staff acknowledgments against the new published version when applicable.
9. Update developer docs and code comments for the callback contract, secrets, and version-on-save invariant.

## Required Companion Skills

- Use `.ai/skills/s3-storage-safety.md` for storage and audit rules.
- Use `.ai/skills/rbac-proof.md` for edit-permission enforcement.
- Use `.ai/skills/acknowledgment-distribution.md` for re-trigger on new version.

## Notes

- OnlyOffice Docs Community Edition caps concurrent editing connections at roughly 20. Sufficient for a single clinic; note this limit in an ADR if broad multi-site concurrent editing is expected. Collabora or a paid tier is the escalation path.
