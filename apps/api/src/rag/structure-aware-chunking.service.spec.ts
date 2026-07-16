import { ChunkingService } from './chunking.service';
import { StructureDetectorService } from './structure-detector.service';
import { StructureAwareChunkingService } from './structure-aware-chunking.service';

describe('StructureAwareChunkingService', () => {
  const svc = new StructureAwareChunkingService(new ChunkingService(), new StructureDetectorService());

  describe('unstructured fallback', () => {
    it('returns [] for empty / whitespace-only text', () => {
      expect(svc.chunk('')).toEqual([]);
      expect(svc.chunk('   \n\n ')).toEqual([]);
    });

    it('chunks unstructured text with NULL structural fields (safe degradation)', () => {
      const text =
        'Free-flowing notes with no headings. ' + 'The quick brown fox. '.repeat(200);
      const chunks = svc.chunk(text, { maxTokens: 100, overlapTokens: 0 });
      expect(chunks.length).toBeGreaterThan(1);
      for (const c of chunks) {
        expect(c.sectionType ?? null).toBeNull();
        expect(c.sectionIdentifier ?? null).toBeNull();
        expect(c.normalizedSectionIdentifier ?? null).toBeNull();
        expect(c.headingPath ?? []).toEqual([]);
        expect(c.pageStart ?? null).toBeNull();
        expect(c.pageEnd ?? null).toBeNull();
      }
      // Contiguous 0-based indices.
      expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
    });

    it('is deterministic', () => {
      const text = 'Policy 705 Title\n' + 'body sentence. '.repeat(100);
      expect(svc.chunk(text)).toEqual(svc.chunk(text));
    });
  });

  describe('never combines two sections in one chunk (hard requirement)', () => {
    it('a chunk never contains text from two different detected sections', () => {
      // Two policies; each body is long enough to force multiple chunks, so we also
      // prove chunking happens WITHIN a section without leaking across the boundary.
      const body705 = 'Restraint may only be used as a last resort. '.repeat(30);
      const body610 = 'Grievances must be filed within thirty days. '.repeat(30);
      const text = `Policy 705 Seclusion\n${body705}\nPolicy 610 Grievances\n${body610}`;

      const chunks = svc.chunk(text, { maxTokens: 120, overlapTokens: 20 });

      // Every chunk belongs to exactly one section identifier.
      for (const c of chunks) {
        const hasRestraint = c.content.includes('last resort');
        const hasGrievance = c.content.includes('thirty days');
        expect(hasRestraint && hasGrievance).toBe(false); // never both
        if (hasRestraint) {
          expect(c.sectionIdentifier).toBe('Policy 705');
          expect(c.normalizedSectionIdentifier).toBe('policy 705');
        }
        if (hasGrievance) {
          expect(c.sectionIdentifier).toBe('Policy 610');
          expect(c.normalizedSectionIdentifier).toBe('policy 610');
        }
      }
      // Both sections actually produced chunks.
      expect(chunks.some((c) => c.normalizedSectionIdentifier === 'policy 705')).toBe(true);
      expect(chunks.some((c) => c.normalizedSectionIdentifier === 'policy 610')).toBe(true);
    });

    it('stamps every chunk of a section with that section identifier + heading path', () => {
      const text = `Chapter 7 Safety\nintro.\nSection 7.1 Controls\n${'control detail. '.repeat(60)}`;
      const chunks = svc.chunk(text, { maxTokens: 80, overlapTokens: 10 });
      const controlChunks = chunks.filter((c) => c.content.includes('control detail'));
      expect(controlChunks.length).toBeGreaterThan(1);
      for (const c of controlChunks) {
        expect(c.sectionIdentifier).toBe('7.1');
        expect(c.headingPath).toEqual(['7', '7.1']);
      }
    });
  });

  describe('generic identifiers across document types', () => {
    const identifiers: Array<[string, string, string]> = [
      ['SOP-0045 Specimen Handling', 'sop', 'sop-0045'],
      ['Clause 8.3 Liability', 'clause', '8.3'],
      ['Article IV Governance', 'article', '4'],
      ['42 CFR Part 2 Confidentiality', 'regulation', '42 cfr part 2'],
      ['Section 504 Rehabilitation', 'section', '504'],
    ];

    it.each(identifiers)('attaches metadata for "%s"', (heading, type, normId) => {
      const text = `${heading}\n${'section body text goes here. '.repeat(40)}`;
      const chunks = svc.chunk(text, { maxTokens: 100, overlapTokens: 0 });
      expect(chunks.length).toBeGreaterThan(0);
      for (const c of chunks) {
        expect(c.sectionType).toBe(type);
        expect(c.normalizedSectionIdentifier).toBe(normId);
      }
    });
  });

  describe('page attribution via form-feed markers', () => {
    it('attributes chunks to the page they fall on when \\f markers are present', () => {
      const page1 = 'Policy 705 Seclusion\n' + 'page one body. '.repeat(20);
      const page2 = 'page two body. '.repeat(20);
      const text = `${page1}\f${page2}`;
      const chunks = svc.chunk(text, { maxTokens: 60, overlapTokens: 0 });

      // At least one chunk on page 1 and one on page 2.
      expect(chunks.some((c) => c.pageStart === 1)).toBe(true);
      expect(chunks.some((c) => c.pageStart === 2)).toBe(true);
      for (const c of chunks) {
        expect(c.pageStart).not.toBeNull();
        expect(c.pageEnd).not.toBeNull();
        expect(c.pageEnd!).toBeGreaterThanOrEqual(c.pageStart!);
      }
    });

    it('leaves page fields null when there are no page markers', () => {
      const text = 'Policy 705 Title\n' + 'no page markers here. '.repeat(40);
      const chunks = svc.chunk(text, { maxTokens: 100, overlapTokens: 0 });
      for (const c of chunks) {
        expect(c.pageStart ?? null).toBeNull();
        expect(c.pageEnd ?? null).toBeNull();
      }
    });
  });
});
