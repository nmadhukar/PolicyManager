/**
 * Duplicate-detection decision core for the importer (pure + unit-tested).
 *
 * The strategy is deliberately explicit and ordered. Before creating a document
 * the service performs up to three lookups against NON-deleted documents and feeds
 * the results here; {@link findDuplicate} picks the first match in strict priority:
 *
 *   1. `documentNumber` — same controlled document number (the strongest identity),
 *   2. `checksum`       — an existing version with the same sha256 (identical bytes),
 *   3. `title+fileName` — a document with the same title AND a version with the same
 *                          file name (a best-effort catch for re-uploads with no number).
 *
 * Keeping the decision pure (no DB) makes the precedence trivially testable and the
 * behaviour identical between the manifest and bulk import paths.
 */

/** Which rule matched — surfaced in the report message and audit metadata. */
export type DedupeReason = 'documentNumber' | 'checksum' | 'title+fileName';

/** Pre-fetched lookup results. A missing/absent match is `null` (or `undefined`). */
export interface DuplicateLookups {
  byDocumentNumber?: { id: string } | null;
  byChecksum?: { documentId: string } | null;
  byTitleFileName?: { id: string } | null;
}

/** A matched duplicate: the existing document + the rule that caught it. */
export interface DedupeResult {
  documentId: string;
  reason: DedupeReason;
}

/**
 * Returns the first duplicate match in priority order, or null when the candidate is
 * new. Pure — all DB access happens in the caller.
 */
export function findDuplicate(lookups: DuplicateLookups): DedupeResult | null {
  if (lookups.byDocumentNumber) {
    return { documentId: lookups.byDocumentNumber.id, reason: 'documentNumber' };
  }
  if (lookups.byChecksum) {
    return { documentId: lookups.byChecksum.documentId, reason: 'checksum' };
  }
  if (lookups.byTitleFileName) {
    return { documentId: lookups.byTitleFileName.id, reason: 'title+fileName' };
  }
  return null;
}

/** Human-readable report line for a skipped duplicate. */
export function duplicateMessage(reason: DedupeReason): string {
  switch (reason) {
    case 'documentNumber':
      return 'Skipped: a document with this document number already exists.';
    case 'checksum':
      return 'Skipped: an identical file (same checksum) already exists.';
    case 'title+fileName':
      return 'Skipped: a document with the same title and file name already exists.';
  }
}
