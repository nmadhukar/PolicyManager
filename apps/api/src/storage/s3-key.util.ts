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

/** Normalizes a prefix to end with exactly one `/` (empty stays empty). */
function normalizePrefix(prefix: string): string {
  return prefix === '' || prefix.endsWith('/') ? prefix : `${prefix}/`;
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
  return `${normalizePrefix(prefix)}${documentId}/v${versionNumber}/${sanitizeFileName(fileName)}`;
}

/**
 * Deterministic key for a version's PDF rendition:
 * `{renditionsPrefix}{documentId}/v{versionNumber}/rendition.pdf`.
 *
 * Contract (AGENTS.md §10a): the rendition is a DERIVED artifact and never the
 * source. Regenerating a version's rendition overwrites only this derived object
 * — the immutable source key (built by {@link buildDocumentObjectKey}) is a
 * disjoint path and is never touched.
 */
export function buildRenditionObjectKey(
  prefix: string,
  documentId: string,
  versionNumber: number,
): string {
  return `${normalizePrefix(prefix)}${documentId}/v${versionNumber}/rendition.pdf`;
}

/**
 * Validates an S3/MinIO bucket name against the DNS-compatible naming rules we
 * enforce for created buckets (a conservative subset of the AWS rules):
 *  - 3–63 characters;
 *  - lowercase letters, digits, and hyphens only;
 *  - must start and end with a letter or digit;
 *  - no consecutive hyphens and not formatted as an IP address.
 * Returns null when valid, or a human-readable reason when not.
 */
export function validateBucketName(name: string): string | null {
  const value = name ?? '';
  if (value.length < 3 || value.length > 63) {
    return 'Bucket name must be between 3 and 63 characters.';
  }
  // Checked before the charset rule so an IP-shaped name gets the specific reason
  // (dots are disallowed by the charset rule below, which would otherwise mask it).
  if (/^\d+\.\d+\.\d+\.\d+$/.test(value)) {
    return 'Bucket name must not be formatted as an IP address.';
  }
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value)) {
    return 'Use lowercase letters, digits, and hyphens; start and end with a letter or digit.';
  }
  if (value.includes('--')) {
    return 'Bucket name must not contain consecutive hyphens.';
  }
  return null;
}

/**
 * Normalizes a user-supplied folder/prefix into a safe, `/`-terminated marker
 * key. Strips leading slashes and traversal, collapses redundant separators, and
 * permits only `[A-Za-z0-9._/-]` segments. Returns null when nothing safe remains.
 */
export function normalizeFolderPrefix(input: string): string | null {
  const segments = (input ?? '')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== '.' && s !== '..')
    .map((s) => s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, ''))
    .filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  return `${segments.join('/')}/`;
}
