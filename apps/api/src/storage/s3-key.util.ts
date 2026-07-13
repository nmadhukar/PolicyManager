/**
 * Deterministic S3 object-key construction for document versions.
 *
 * Contract (AGENTS.md §9): keys MUST be deterministic and versioned by
 * document/version, so every upload lands at a unique, reproducible location and
 * prior version bytes are never overwritten.
 */

/**
 * Reduces an uploaded file name to a single, storage-safe path segment.
 *
 * - Keeps only the final path component (defeats `../` traversal and absolute
 *   paths — a malicious name can never escape the document/version prefix).
 * - Replaces any character outside `[A-Za-z0-9._-]` with `_`.
 * - Falls back to `file` when nothing safe remains.
 */
export function sanitizeFileName(fileName: string): string {
  const base = (fileName ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned : 'file';
}

/**
 * Builds the canonical object key: `{prefix}{documentId}/v{versionNumber}/{safeFileName}`.
 * The prefix is normalized to end with exactly one `/`.
 */
export function buildDocumentObjectKey(
  prefix: string,
  documentId: string,
  versionNumber: number,
  fileName: string,
): string {
  const normalizedPrefix = prefix === '' || prefix.endsWith('/') ? prefix : `${prefix}/`;
  return `${normalizedPrefix}${documentId}/v${versionNumber}/${sanitizeFileName(fileName)}`;
}
