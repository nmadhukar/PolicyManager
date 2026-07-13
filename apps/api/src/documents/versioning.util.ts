import { createHash } from 'crypto';

/**
 * Content-addressed checksum for an uploaded file. Stored on every
 * DocumentVersion so integrity/immutability can be proven (AGENTS.md §9).
 */
export function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Next immutable version number for a document, given the current maximum
 * (null/undefined => the document has no versions yet => start at 1). Versions
 * are monotonic and never reused.
 */
export function computeNextVersionNumber(currentMax: number | null | undefined): number {
  return (currentMax ?? 0) + 1;
}
