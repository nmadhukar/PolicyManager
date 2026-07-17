import { Injectable } from '@nestjs/common';
import type { RagCitation, RagContext } from '@policymanager/shared';
import type { RetrievedChunk } from '../retriever.service';
import { RagConfigService } from '../rag-config.service';

/** Max characters of a chunk excerpt kept for a citation snippet. */
const SNIPPET_MAX_CHARS = 240;

/**
 * Turns retrieved chunks into a numbered grounding context + parallel citation
 * list. Deterministic (same chunks → same output) so answers are reproducible.
 * The `contextText` is what the LLM grounds on; each passage is prefixed with its
 * 1-based marker ([1], [2], …) matching the citation index, so the model can
 * reference sources by number and we can map those markers back to documents.
 *
 * Enforces a character budget: passages are added in rank order until the budget
 * is reached; lower-ranked chunks that don't fit are dropped, and citations stay
 * exactly in sync with what actually made it into `contextText`.
 */
@Injectable()
export class ContextBuilder {
  constructor(private readonly ragConfig: RagConfigService) {}

  build(chunks: RetrievedChunk[]): RagContext {
    if (chunks.length === 0) {
      return { contextText: '', citations: [], empty: true };
    }

    // Dedup identical chunks (same chunkId) while preserving rank order.
    const seen = new Set<string>();
    const unique: RetrievedChunk[] = [];
    for (const c of chunks) {
      if (seen.has(c.chunkId)) continue;
      seen.add(c.chunkId);
      unique.push(c);
    }

    const budget = Math.max(0, this.ragConfig.contextMaxChars);
    const citations: RagCitation[] = [];
    const passages: string[] = [];
    let used = 0;

    for (const chunk of unique) {
      const index = citations.length + 1;
      const header = `[${index}] ${this.sourceLabel(chunk)}\n`;
      const body = chunk.content.trim();
      const passage = `${header}${body}`;
      const cost = passage.length + 2; // +2 for the joining blank line

      // Always include at least the first passage (clipped if needed) so a single
      // large chunk still yields usable context; subsequent ones must fit.
      if (used + cost > budget && citations.length > 0) break;

      let finalBody = body;
      if (used + header.length + body.length + 2 > budget) {
        const room = Math.max(0, budget - used - header.length - 2);
        finalBody = body.slice(0, room).trimEnd();
      }
      const finalPassage = `${header}${finalBody}`;
      passages.push(finalPassage);
      used += finalPassage.length + 2;

      citations.push({
        index,
        documentId: chunk.documentId,
        versionId: chunk.versionId,
        chunkId: chunk.chunkId,
        documentTitle: chunk.documentTitle,
        documentNumber: chunk.documentNumber,
        // Version-aware citation fields (Phase 4): which version + effective date
        // answered, and the exact section + page, so a reader can locate the source.
        versionNumber: chunk.versionNumber,
        effectiveDate: chunk.effectiveDate ? chunk.effectiveDate.toISOString() : null,
        sectionIdentifier: chunk.sectionIdentifier,
        sectionTitle: chunk.sectionTitle,
        pageStart: chunk.pageStart,
        pageEnd: chunk.pageEnd,
        snippet: this.snippet(chunk.content),
      });

      if (used >= budget) break;
    }

    return {
      contextText: passages.join('\n\n'),
      citations,
      empty: citations.length === 0,
    };
  }

  /**
   * Human-readable source label for a passage header. Names the document, its
   * number, the section (identifier + title), the page span, and the version — so
   * the grounding context itself tells the model exactly which source each passage
   * is, and two documents sharing a section number are never confusable.
   */
  private sourceLabel(chunk: RetrievedChunk): string {
    const parts: string[] = [chunk.documentTitle];
    if (chunk.documentNumber) parts[0] += ` (${chunk.documentNumber})`;
    const section = this.sectionLabel(chunk);
    if (section) parts.push(section);
    if (chunk.pageStart) {
      parts.push(chunk.pageEnd && chunk.pageEnd !== chunk.pageStart
        ? `pp. ${chunk.pageStart}–${chunk.pageEnd}`
        : `p. ${chunk.pageStart}`);
    }
    if (chunk.versionNumber) parts.push(`v${chunk.versionNumber}`);
    return parts.join(' · ');
  }

  /** "§ <identifier> <title>" when a section is known, else "". */
  private sectionLabel(chunk: RetrievedChunk): string {
    const id = chunk.sectionIdentifier?.trim();
    const title = chunk.sectionTitle?.trim();
    if (id && title) return `§ ${id} ${title}`;
    if (id) return `§ ${id}`;
    if (title) return title;
    return '';
  }

  /** A trimmed, single-line-ish excerpt for citation display. */
  private snippet(content: string): string {
    const collapsed = content.replace(/\s+/g, ' ').trim();
    return collapsed.length > SNIPPET_MAX_CHARS
      ? `${collapsed.slice(0, SNIPPET_MAX_CHARS).trimEnd()}…`
      : collapsed;
  }
}
