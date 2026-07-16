import { Injectable } from '@nestjs/common';

/**
 * Generic, document-type-neutral structural provenance for a chunk (ADR-0004,
 * Option A). Every field is OPTIONAL: the plain token chunker leaves them unset,
 * and an unstructured document keeps them unset — both persist as null/[]/{} via
 * {@link TextChunk}. The structure-aware chunker (Phase 2) populates them.
 */
export interface ChunkStructure {
  /** Coarse class: "policy" | "sop" | "clause" | "article" | "section" | … (free string). */
  sectionType?: string | null;
  /** Raw identifier as printed ("705", "SOP-0045", "8.3", "IV", "42 CFR Part 2"). */
  sectionIdentifier?: string | null;
  /** Folded identifier for exact lookup ("sop-0045", "8.3", "4" for "IV"). */
  normalizedSectionIdentifier?: string | null;
  /** Human title of the section. */
  sectionTitle?: string | null;
  /** Ordered heading breadcrumb root→leaf; empty/omitted for unstructured. */
  headingPath?: string[];
  /** 1-based inclusive page span, when the extractor supplies page geometry. */
  pageStart?: number | null;
  pageEnd?: number | null;
  /** Detector-/type-specific extras. Never secrets. */
  metadata?: Record<string, unknown>;
}

/** A single retrieval-sized slice of a document, ready for embedding. */
export interface TextChunk extends ChunkStructure {
  /** The chunk text. Never empty and never whitespace-only (chunks are trimmed). */
  content: string;
  /** 0-based index, contiguous within the returned array (0, 1, 2, ...). */
  chunkIndex: number;
  /**
   * Estimated tokens for this chunk. Always > 0 — the DB enforces a CHECK
   * constraint (tokenCount > 0), so this invariant is load-bearing.
   */
  tokenCount: number;
}

/** Tuning knobs for {@link ChunkingService.chunk}. */
export interface ChunkOptions {
  /** Target maximum tokens per chunk (default {@link DEFAULT_MAX_TOKENS}). */
  maxTokens?: number;
  /** Token overlap carried between consecutive chunks (default {@link DEFAULT_OVERLAP_TOKENS}). */
  overlapTokens?: number;
}

/** Average characters per token used by the deterministic estimator. */
const CHARS_PER_TOKEN = 4;

/** Default target size of a chunk, in estimated tokens. */
const DEFAULT_MAX_TOKENS = 500;

/** Default overlap between consecutive chunks, in estimated tokens. */
const DEFAULT_OVERLAP_TOKENS = 60;

/**
 * Hard-ceiling multiplier over `maxTokens`. A chunk is *targeted* at
 * `maxTokens`, but boundary preference means the actual size floats a little;
 * this multiplier is the absolute upper bound we will never exceed. It also
 * matches the ceiling the test suite asserts against (`maxTokens * 1.5`).
 */
const HARD_CEILING_MULTIPLIER = 1.5;

/** Break points we try, in order of decreasing semantic value. */
const BREAK_SEPARATORS: readonly string[] = ['\n\n', '\n', '. ', ' '];

/**
 * Splits extracted document text into overlapping, retrieval-sized chunks.
 *
 * The service is intentionally PURE and DETERMINISTIC: given the same input and
 * options it returns an identical array on every call. It reads no clock, no
 * random source, and no external state, which keeps it trivially unit-testable
 * and safe to run in the extraction pipeline or a backfill job alike.
 *
 * Token counting here is a deliberate *approximation* (~4 characters per token).
 * Real tokenization belongs to the embedding model; this heuristic exists only
 * to budget chunk sizes and drive splitting. It never needs to be exact — it
 * only needs to be stable and roughly proportional to real token counts.
 *
 * Performance: the input is capped at 1,000,000 characters upstream
 * (MAX_EXTRACTED_TEXT_CHARS). The algorithm walks the text with numeric indices
 * and slices once per chunk, so it is O(n) in the input length. It never builds
 * a chunk via repeated string concatenation in a loop, so there is no quadratic
 * blow-up on large inputs.
 */
@Injectable()
export class ChunkingService {
  /**
   * Estimates the token count of a string using a deterministic heuristic:
   * `ceil(length / 4)`, i.e. roughly four characters per token.
   *
   * This is an approximation, not a real tokenizer. It is monotonic in length
   * (longer text never estimates fewer tokens) and returns 0 for empty input,
   * which makes it safe both for budgeting chunk sizes and for the empty-input
   * short-circuit in {@link chunk}.
   */
  estimateTokens(text: string): number {
    if (text.length === 0) return 0;
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }

  /**
   * Splits `text` into overlapping chunks of roughly `maxTokens` tokens each.
   *
   * Guarantees (all covered by unit tests):
   * - Deterministic: same input + options → identical output.
   * - No empty/whitespace-only chunk is ever emitted (chunks are trimmed, and
   *   trimmed-empty candidates are dropped).
   * - `chunkIndex` is 0-based and contiguous (0, 1, 2, ...).
   * - Every `tokenCount` is > 0.
   * - No chunk exceeds the hard ceiling (`maxTokens * HARD_CEILING_MULTIPLIER`),
   *   even for a single unbroken token (a giant URL) — such input is
   *   hard-split at the character level.
   */
  chunk(text: string, options?: ChunkOptions): TextChunk[] {
    const maxTokens = normalizePositive(options?.maxTokens, DEFAULT_MAX_TOKENS);
    // Overlap defaults to DEFAULT_OVERLAP_TOKENS but may be explicitly set to 0
    // to disable overlap. It is clamped below maxTokens so overlap can never
    // consume an entire chunk's worth of budget (see the infinite-loop invariant
    // on `advanceFrom`).
    const overlapTokens = clampOverlap(options?.overlapTokens, maxTokens);

    // Fast path / correctness: whitespace-only or empty input yields no chunks.
    if (text.trim().length === 0) return [];

    const maxChars = maxTokens * CHARS_PER_TOKEN;
    const ceilingChars = Math.floor(maxTokens * HARD_CEILING_MULTIPLIER) * CHARS_PER_TOKEN;
    const overlapChars = overlapTokens * CHARS_PER_TOKEN;

    const chunks: TextChunk[] = [];
    const n = text.length;
    let start = 0;

    while (start < n) {
      // Choose where this chunk ends. `findChunkEnd` returns an index strictly
      // greater than `start`, so `end - start >= 1` always holds.
      const end = this.findChunkEnd(text, start, maxChars, ceilingChars);
      const raw = text.slice(start, end);
      const content = raw.trim();

      // A slice can trim to empty (e.g. a run of blank lines). Skip it, but keep
      // advancing so the loop always terminates.
      if (content.length > 0) {
        chunks.push({
          content,
          chunkIndex: chunks.length,
          tokenCount: Math.max(1, this.estimateTokens(content)),
        });
      }

      if (end >= n) break;

      // Advance the window. Overlap carries trailing context forward to improve
      // retrieval recall, but ONLY across a natural boundary. On a hard split
      // (`hitCeiling`) we advance with zero overlap: overlapping an arbitrary
      // mid-token cut adds no semantic recall, and — for a highly repetitive
      // unbroken token (e.g. a 5000-char run of one character) — overlapping the
      // hard cut would emit byte-for-byte identical consecutive chunks. Skipping
      // overlap there keeps every character in exactly one chunk and honors the
      // "no duplicate whole chunks" invariant. Either way the next start is
      // strictly greater than the current one (see `advanceFrom`), so the loop
      // cannot spin.
      const hitCeiling = end === start + ceilingChars;
      start = advanceFrom(start, end, hitCeiling ? 0 : overlapChars);
    }

    return chunks;
  }

  /**
   * Finds the exclusive end index for a chunk beginning at `start`.
   *
   * Boundary-preference cascade: we would like the chunk to be about `maxChars`
   * long, so we look for the LAST occurrence of a separator within the target
   * window, trying separators from most semantic ("\n\n") to least (" "). The
   * first separator that yields a break comfortably past the window midpoint
   * wins, so we split on paragraph/sentence/word boundaries when we reasonably
   * can. If nothing suitable is found (e.g. one unbroken 5000-char token) we
   * fall back to a hard character split at the ceiling. The returned index is
   * always > `start`, guaranteeing forward progress.
   */
  private findChunkEnd(text: string, start: number, maxChars: number, ceilingChars: number): number {
    const n = text.length;

    // Whole remainder already fits within the target window: take it all.
    if (n - start <= maxChars) return n;

    // The window in which we prefer to find a natural boundary.
    const windowEnd = Math.min(start + maxChars, n);
    // Only accept a boundary in the back half of the window; otherwise chunks
    // become tiny and we churn out far more of them than necessary.
    const minBreak = start + Math.floor(maxChars / 2);

    for (const sep of BREAK_SEPARATORS) {
      // lastIndexOf scans backward from the window edge, so we naturally get the
      // break closest to the target size without an O(n^2) forward search.
      const idx = text.lastIndexOf(sep, windowEnd - 1);
      if (idx >= minBreak && idx < windowEnd) {
        // Break AFTER the separator so its characters stay with this chunk and
        // the next chunk starts clean. Clamp to windowEnd for safety.
        const candidate = Math.min(idx + sep.length, windowEnd);
        if (candidate > start) return candidate;
      }
    }

    // No usable boundary in range: hard-split. Never exceed the ceiling. This is
    // the path a giant unbroken token (a long URL) takes.
    return Math.min(start + ceilingChars, n);
  }
}

/** Returns a positive integer, or `fallback` when `value` is missing/invalid. */
function normalizePositive(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

/**
 * Resolves and clamps the overlap into `[0, maxTokens - 1]`.
 *
 * A missing/invalid value falls back to {@link DEFAULT_OVERLAP_TOKENS}; an
 * explicit `0` is honored and disables overlap entirely. The upper clamp is the
 * safety half of the infinite-loop invariant: if overlap could equal (or
 * exceed) a full chunk, the next window could start at or before the current
 * one. Keeping it strictly below `maxTokens`, combined with `advanceFrom`,
 * guarantees the start index strictly increases on every iteration.
 */
function clampOverlap(value: number | undefined, maxTokens: number): number {
  const resolved =
    typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : DEFAULT_OVERLAP_TOKENS;
  return Math.min(resolved, Math.max(0, maxTokens - 1));
}

/**
 * Computes the next window start given the current `start`, the current chunk's
 * `end`, and the desired `overlapChars`.
 *
 * INVARIANT (prevents infinite loops and duplicate chunks): the result is
 * strictly greater than `start`. We subtract the overlap from `end`, but never
 * allow the new start to fall back to `start` or earlier — in the worst case we
 * advance by exactly one character. Because `end > start` always holds, this
 * function can always return at least `start + 1`.
 */
function advanceFrom(start: number, end: number, overlapChars: number): number {
  const next = end - overlapChars;
  return next > start ? next : start + 1;
}
