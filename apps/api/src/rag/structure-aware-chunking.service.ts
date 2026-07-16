import { Injectable } from '@nestjs/common';
import { ChunkingService, type ChunkOptions, type TextChunk } from './chunking.service';
import { StructureDetectorService, type StructuralSegment } from './structure-detector.service';

/**
 * Builds an index of page boundaries from form-feed (`\f`) markers in the text.
 * PDFs extracted with page markers (see TextExtractionService) carry a `\f`
 * between pages; text with no `\f` yields a single "page 1" spanning everything,
 * and pageStart/pageEnd degrade to null (see {@link pageRangeFor}).
 */
class PageIndex {
  /** Sorted character offsets at which each page STARTS (page 1 starts at 0). */
  private readonly pageStarts: number[];
  /** True only when the source actually contained page markers. */
  readonly hasPages: boolean;

  constructor(text: string) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\f') starts.push(i + 1);
    }
    this.pageStarts = starts;
    this.hasPages = starts.length > 1;
  }

  /** 1-based page number containing character offset `pos` (binary search). */
  private pageAt(pos: number): number {
    let lo = 0;
    let hi = this.pageStarts.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.pageStarts[mid] <= pos) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans + 1; // 1-based
  }

  /**
   * Inclusive [pageStart, pageEnd] for the character span [start, end). Returns
   * nulls when the source had no page markers (unstructured / non-paginated).
   */
  pageRangeFor(start: number, end: number): { pageStart: number | null; pageEnd: number | null } {
    if (!this.hasPages) return { pageStart: null, pageEnd: null };
    const pageStart = this.pageAt(start);
    const pageEnd = this.pageAt(Math.max(start, end - 1));
    return { pageStart, pageEnd: Math.max(pageStart, pageEnd) };
  }
}

/**
 * Structure-aware chunker (RAG Phase 2). Composes {@link StructureDetectorService}
 * and the pure {@link ChunkingService}:
 *
 *  1. Detect generic structural boundaries (chapters, sections, articles, clauses,
 *     policies, SOPs, appendices, regulations) and segment the text into units.
 *  2. Chunk WITHIN each unit only — never across a boundary — using the existing
 *     token chunker, so a chunk can never combine the tail of one section with the
 *     head of the next (a hard requirement).
 *  3. Stamp every chunk with its structural metadata (sectionType, identifier,
 *     normalizedIdentifier, title, root→leaf headingPath) and page span.
 *
 * Falls back to plain token chunking for UNSTRUCTURED text: when the detector
 * finds no headings, the whole document is one segment with null structural
 * fields — identical output to {@link ChunkingService.chunk} plus null metadata.
 *
 * PURE and DETERMINISTIC (delegates to two pure services); safe in the embedding
 * worker or a backfill alike.
 */
@Injectable()
export class StructureAwareChunkingService {
  constructor(
    private readonly chunking: ChunkingService,
    private readonly detector: StructureDetectorService,
  ) {}

  /**
   * Produce structure-aware chunks with contiguous 0-based `chunkIndex` across the
   * whole document (the DB requires contiguous ordinals per version). Each chunk
   * carries the metadata of the segment it came from; page span is derived from
   * `\f` markers when present.
   */
  chunk(text: string, options?: ChunkOptions): TextChunk[] {
    if (text.trim().length === 0) return [];

    const pages = new PageIndex(text);
    const segments = this.detector.segment(text);
    const out: TextChunk[] = [];

    for (const segment of segments) {
      // Chunk this unit's text in isolation — boundaries never cross segments.
      const local = this.chunking.chunk(segment.text, options);
      for (const c of local) {
        // Map the local chunk back to an absolute offset for its page range.
        // The token chunker trims, so find the trimmed content within the segment;
        // fall back to the segment start when the exact offset can't be located
        // (page span stays within the segment, which is correct either way).
        const rel = segment.text.indexOf(c.content);
        const absStart = segment.start + (rel >= 0 ? rel : 0);
        const absEnd = absStart + c.content.length;
        const { pageStart, pageEnd } = pages.pageRangeFor(absStart, absEnd);

        out.push({
          content: c.content,
          chunkIndex: out.length, // re-number contiguously across all segments
          tokenCount: c.tokenCount,
          ...this.metadataFor(segment, pageStart, pageEnd),
        });
      }
    }

    return out;
  }

  /** Structural fields for a chunk, from its segment. Nulls for the unstructured segment. */
  private metadataFor(
    segment: StructuralSegment,
    pageStart: number | null,
    pageEnd: number | null,
  ): Omit<TextChunk, 'content' | 'chunkIndex' | 'tokenCount'> {
    const h = segment.heading;
    return {
      sectionType: h?.sectionType ?? null,
      sectionIdentifier: h?.sectionIdentifier ?? null,
      normalizedSectionIdentifier: h?.normalizedSectionIdentifier ?? null,
      sectionTitle: h?.sectionTitle ?? null,
      headingPath: segment.headingPath,
      pageStart,
      pageEnd,
      metadata: {},
    };
  }
}
