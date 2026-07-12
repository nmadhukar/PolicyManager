# Skill: Document Rendition And Viewer

## Purpose

Produce a uniform PDF rendition of any supported document and view it in the browser without downloading, and without mutating source bytes.

## Use When

- Adding upload processing that must support PDF, DOCX/DOC, XLSX/XLS, PPTX/PPT, images, TXT/MD.
- Adding an in-browser viewer.
- Adding cover-page prepend on export.

## Procedure

1. Keep the uploaded original as the immutable source `DocumentVersion` (never converted in place).
2. On upload, if the source is not already PDF, convert to a PDF rendition using Gotenberg (LibreOffice route).
3. Store the rendition in S3/MinIO under a deterministic key derived from `documentId`/`versionNumber`; record it as `renditionS3Key` on the version.
4. Serve viewing via the PDF rendition using pdf.js/react-pdf; images may render natively.
5. Authorize before issuing any presigned rendition URL; audit the view like a download.
6. Never expose an editor to view-only users; the viewer is read-only.
7. Handle conversion failure gracefully: mark rendition unavailable, allow original download, log for follow-up.
8. Update developer docs and code comments for the conversion contract and failure modes.

## Required Companion Skills

- Use `.ai/skills/s3-storage-safety.md` for key/privacy/audit rules.
- Use `.ai/skills/coverpage-export.md` when prepending the compliance cover page onto the rendition.
