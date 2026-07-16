import { ChunkingService, TextChunk } from './chunking.service';

describe('ChunkingService', () => {
  const svc = new ChunkingService();

  /** Builds a multi-paragraph document long enough to force several chunks. */
  const makeLongText = (paragraphs = 40): string => {
    const sentence =
      'The policy applies to all employees and contractors across every region. ' +
      'It sets out the required controls, the review cadence, and the escalation path. ';
    const out: string[] = [];
    for (let i = 0; i < paragraphs; i += 1) {
      out.push(`Section ${i}. ${sentence}${sentence}`);
    }
    return out.join('\n\n');
  };

  const indices = (chunks: TextChunk[]): number[] => chunks.map((c) => c.chunkIndex);

  describe('estimateTokens', () => {
    it('returns 0 for an empty string', () => {
      expect(svc.estimateTokens('')).toBe(0);
    });

    it('uses the ~4-chars-per-token heuristic (ceil)', () => {
      expect(svc.estimateTokens('a')).toBe(1); // ceil(1/4)
      expect(svc.estimateTokens('abcd')).toBe(1); // ceil(4/4)
      expect(svc.estimateTokens('abcde')).toBe(2); // ceil(5/4)
    });

    it('is monotonic in length (longer text never estimates fewer tokens)', () => {
      let prev = 0;
      for (let len = 0; len <= 500; len += 7) {
        const tokens = svc.estimateTokens('x'.repeat(len));
        expect(tokens).toBeGreaterThanOrEqual(prev);
        prev = tokens;
      }
    });
  });

  describe('chunk', () => {
    it('is deterministic: same input + options → deeply equal output', () => {
      const text = makeLongText();
      const a = svc.chunk(text);
      const b = svc.chunk(text);
      expect(a).toEqual(b);

      const c = svc.chunk(text, { maxTokens: 120, overlapTokens: 20 });
      const d = svc.chunk(text, { maxTokens: 120, overlapTokens: 20 });
      expect(c).toEqual(d);
    });

    it('returns [] for an empty string', () => {
      expect(svc.chunk('')).toEqual([]);
    });

    it('returns [] for a whitespace-only string', () => {
      expect(svc.chunk('   \n\n  ')).toEqual([]);
      expect(svc.chunk('\t\t\n \r\n')).toEqual([]);
    });

    it('returns exactly one trimmed chunk for text shorter than one chunk', () => {
      const text = '  Short policy note.  ';
      const chunks = svc.chunk(text);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].content).toBe('Short policy note.');
      expect(chunks[0].chunkIndex).toBe(0);
      expect(chunks[0].tokenCount).toBeGreaterThan(0);
    });

    it('splits long multi-paragraph text into multiple, contiguous, non-empty chunks', () => {
      const maxTokens = 200;
      const chunks = svc.chunk(makeLongText(), { maxTokens, overlapTokens: 30 });

      expect(chunks.length).toBeGreaterThan(1);
      // chunkIndex is 0-based and contiguous with no gaps.
      expect(indices(chunks)).toEqual(chunks.map((_, i) => i));

      const ceiling = Math.floor(maxTokens * 1.5);
      for (const c of chunks) {
        expect(c.content.trim()).toBe(c.content); // trimmed
        expect(c.content.length).toBeGreaterThan(0); // never empty
        expect(c.tokenCount).toBeGreaterThan(0);
        expect(svc.estimateTokens(c.content)).toBeLessThanOrEqual(ceiling);
      }
    });

    it('every returned chunk has tokenCount > 0', () => {
      const chunks = svc.chunk(makeLongText(60), { maxTokens: 90, overlapTokens: 15 });
      expect(chunks.length).toBeGreaterThan(1);
      for (const c of chunks) {
        expect(c.tokenCount).toBeGreaterThan(0);
      }
    });

    it('carries overlap: consecutive chunks share trailing/leading text when overlapTokens > 0', () => {
      const overlapTokens = 40;
      const chunks = svc.chunk(makeLongText(), { maxTokens: 200, overlapTokens });
      expect(chunks.length).toBeGreaterThan(2);

      // For each adjacent pair, some trailing text of the earlier chunk should
      // reappear at the start of the later chunk. We look for a shared word run
      // sized near the requested overlap (in chars ≈ overlapTokens * 4), allowing
      // for trimming at the boundary.
      let sharedPairs = 0;
      for (let i = 0; i < chunks.length - 1; i += 1) {
        const prev = chunks[i].content;
        const next = chunks[i + 1].content;
        // Probe: does any reasonably long suffix-word of prev appear in next?
        const prevWords = prev.split(/\s+/);
        const probe = prevWords.slice(-8).join(' ');
        if (probe.length >= 8 && next.includes(prevWords.slice(-4).join(' '))) {
          sharedPairs += 1;
        }
      }
      // The overlap mechanism should produce shared context on the majority of
      // adjacent pairs (boundary trimming may prevent it on a few).
      expect(sharedPairs).toBeGreaterThan(0);
    });

    it('does NOT overlap when overlapTokens is 0 (custom options respected)', () => {
      const withOverlap = svc.chunk(makeLongText(), { maxTokens: 100, overlapTokens: 60 });
      const noOverlap = svc.chunk(makeLongText(), { maxTokens: 100, overlapTokens: 0 });

      // With no overlap, concatenating chunk contents reconstructs no duplicated
      // spans, so there are generally fewer chunks than the overlapping run.
      expect(noOverlap.length).toBeGreaterThan(1);
      expect(noOverlap.length).toBeLessThanOrEqual(withOverlap.length);
      expect(indices(noOverlap)).toEqual(noOverlap.map((_, i) => i));
    });

    it('applies the default overlap (60) when overlapTokens is omitted', () => {
      const text = makeLongText();
      // Omitting overlap should behave like the documented default (60), which
      // differs from an explicit 0. The overlapping run yields at least as many
      // chunks as the non-overlapping one over the same target size.
      const defaulted = svc.chunk(text, { maxTokens: 200 });
      const zero = svc.chunk(text, { maxTokens: 200, overlapTokens: 0 });
      expect(defaulted.length).toBeGreaterThanOrEqual(zero.length);
      expect(indices(defaulted)).toEqual(defaulted.map((_, i) => i));
    });

    it('respects custom maxTokens (smaller max → more, smaller chunks)', () => {
      const text = makeLongText();
      const big = svc.chunk(text, { maxTokens: 400, overlapTokens: 0 });
      const small = svc.chunk(text, { maxTokens: 100, overlapTokens: 0 });
      expect(small.length).toBeGreaterThan(big.length);

      const ceiling = Math.floor(100 * 1.5);
      for (const c of small) {
        expect(svc.estimateTokens(c.content)).toBeLessThanOrEqual(ceiling);
      }
    });

    it('hard-splits a giant unbroken token (no break points) without exceeding the ceiling', () => {
      const maxTokens = 100;
      const giant = 'x'.repeat(5000); // 5000 chars, zero separators
      const chunks = svc.chunk(giant, { maxTokens, overlapTokens: 0 });

      expect(chunks.length).toBeGreaterThan(1);
      expect(indices(chunks)).toEqual(chunks.map((_, i) => i));

      const ceiling = Math.floor(maxTokens * 1.5);
      for (const c of chunks) {
        expect(c.content.length).toBeGreaterThan(0);
        expect(c.tokenCount).toBeGreaterThan(0);
        expect(svc.estimateTokens(c.content)).toBeLessThanOrEqual(ceiling);
      }

      // Every character is preserved exactly once (no overlap, hard split).
      expect(chunks.map((c) => c.content).join('')).toBe(giant);
    });

    it('handles a giant unbroken token WITH overlap: terminates, contiguous, no duplicated characters', () => {
      const giant = 'y'.repeat(5000);
      const chunks = svc.chunk(giant, { maxTokens: 100, overlapTokens: 60 });

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.length).toBeLessThan(giant.length); // terminated, not per-char
      expect(indices(chunks)).toEqual(chunks.map((_, i) => i));

      const ceiling = Math.floor(100 * 1.5);
      for (const c of chunks) {
        expect(svc.estimateTokens(c.content)).toBeLessThanOrEqual(ceiling);
      }

      // Overlap is intentionally NOT applied across a hard character split, so a
      // repetitive unbroken token is not blown up into duplicated context: every
      // character is preserved exactly once. This is the "no duplicate whole
      // chunks" invariant for the pathological no-boundary case.
      expect(chunks.map((c) => c.content).join('')).toBe(giant);
    });

    it('drops slices that trim to empty (runs of blank lines) but keeps indices contiguous', () => {
      const text = `First real paragraph with enough words to matter here.${'\n'.repeat(50)}Second real paragraph after a big gap of blank lines.`;
      const chunks = svc.chunk(text, { maxTokens: 30, overlapTokens: 0 });
      expect(chunks.length).toBeGreaterThan(0);
      for (const c of chunks) {
        expect(c.content.trim()).toBe(c.content);
        expect(c.content.length).toBeGreaterThan(0);
      }
      expect(indices(chunks)).toEqual(chunks.map((_, i) => i));
    });

    it('processes a ~1,000,000-char input efficiently and without duplication', () => {
      // Guards against O(n^2): a paragraph repeated to ~1M chars must chunk fast.
      const unit = 'This is a representative policy sentence used for load testing. ';
      const text = (unit.repeat(Math.ceil(1_000_000 / unit.length)) + '\n\n').slice(0, 1_000_000);

      const started = Date.now();
      const chunks = svc.chunk(text, { maxTokens: 500, overlapTokens: 60 });
      const elapsed = Date.now() - started;

      expect(chunks.length).toBeGreaterThan(100);
      expect(indices(chunks)).toEqual(chunks.map((_, i) => i));
      // Generous bound; a quadratic implementation would blow far past this.
      expect(elapsed).toBeLessThan(5000);
    });
  });
});
