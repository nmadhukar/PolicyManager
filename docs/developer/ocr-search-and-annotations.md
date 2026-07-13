# OCR, Search, and Review Annotations

## OCR and Extraction

Uploads create `DocumentVersion` rows with `extractionStatus = pending`. The upload path does not run parsers or OCR inside the version transaction. `DocumentExtractionService` claims pending rows, downloads source bytes through `S3Service`, and updates only extraction metadata:

- `extractedText`
- `hasExtractedText`
- `extractionStatus`
- `extractionError`
- `ocrApplied`

Source bytes remain immutable. Failed/skipped extraction never blocks upload, download, viewing, approval, or version restore.

OCR is disabled unless `OCR_ENABLED=true` and `OCR_ENDPOINT` is configured. The endpoint must be internal/self-hosted and accept:

```text
POST /ocr
multipart/form-data: file, mimeType
response: text/plain or application/json { "text": "..." }
```

Scanned PDFs/images are marked `skipped` when OCR is unavailable. Operators can queue all live versions again with:

```text
POST /documents/extraction/reindex
permission: storage.manage
```

## Search

`DocumentVersion.searchVector` is a stored PostgreSQL `tsvector` in the `policytracker` schema with a GIN index. The public API search uses this vector plus document metadata while preserving the public visibility floor:

- published documents only
- not soft-deleted
- not confidential
- inside the API client's category allow-list

The internal document library also searches the current version's extracted text so OCR output is discoverable from the UI.

Public `/api/v1/search` requires both `documents:read` and `content:read` because each hit can include an extracted-text snippet.

## Review Annotations

`DocumentAnnotation` stores page-anchored comments against immutable versions. Annotations are internal only; public API, cover-page, and export flows do not read this model.

Authorization rules:

- Listing requires `document.read` plus document view access.
- Listing returns `canAnnotate` and `canComplianceDelete` so the viewer can expose reviewer-only annotation affordances from server-calculated capability, not role guesses.
- Creating requires document view access and either `document.comment`, an assigned reviewer record, or an open review task for the same version. Versionless legacy tasks only authorize annotation on the document's current version.
- Resolve/reopen requires the author, comment permission, or reviewer assignment/task for the same version.
- Delete is soft-delete only and limited to the author, Admin, or Compliance Officer.

Every create, resolve, reopen, and delete writes an audit event. Open annotation counts are returned on document detail and review tasks so approvers/reviewers see unresolved issues before sign-off.
