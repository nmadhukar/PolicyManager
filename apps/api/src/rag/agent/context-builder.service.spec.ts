import { ContextBuilder } from './context-builder.service';
import type { RagConfigService } from '../rag-config.service';
import type { RetrievedChunk } from '../retriever.service';

describe('ContextBuilder', () => {
  const chunk = (over: Partial<RetrievedChunk> = {}): RetrievedChunk => ({
    documentId: 'doc-1',
    versionId: 'v-1',
    chunkId: 'c-1',
    chunkIndex: 0,
    content: 'Seclusion may be used only as a last resort.',
    score: 0.9,
    documentTitle: 'Seclusion Policy',
    documentNumber: 'PP-42',
    versionNumber: 1,
    effectiveDate: null,
    exactMatch: false,
    adjacent: false,
    sectionType: null,
    sectionIdentifier: null,
    normalizedSectionIdentifier: null,
    sectionTitle: null,
    headingPath: [],
    pageStart: null,
    pageEnd: null,
    ...over,
  });

  const makeConfig = (contextMaxChars = 8000): RagConfigService =>
    ({ contextMaxChars }) as unknown as RagConfigService;

  const build = (max = 8000) => new ContextBuilder(makeConfig(max));

  it('returns empty context for no chunks (AC5)', () => {
    const ctx = build().build([]);
    expect(ctx).toEqual({ contextText: '', citations: [], empty: true });
  });

  it('numbers passages and produces parallel citations (AC3/AC7)', () => {
    const ctx = build().build([
      chunk({ chunkId: 'c-1', content: 'First passage.' }),
      chunk({ chunkId: 'c-2', content: 'Second passage.', documentId: 'doc-2', documentTitle: 'Restraint Policy', documentNumber: 'PP-9' }),
    ]);
    expect(ctx.empty).toBe(false);
    expect(ctx.citations).toHaveLength(2);
    expect(ctx.citations[0].index).toBe(1);
    expect(ctx.citations[1].index).toBe(2);
    // contextText carries the markers in order.
    expect(ctx.contextText).toMatch(/\[1\] Seclusion Policy \(PP-42\)/);
    expect(ctx.contextText).toMatch(/\[2\] Restraint Policy \(PP-9\)/);
    expect(ctx.contextText).toContain('First passage.');
    expect(ctx.contextText).toContain('Second passage.');
    // citations carry deep-link fields + snippet.
    expect(ctx.citations[1]).toMatchObject({
      documentId: 'doc-2',
      versionId: 'v-1',
      chunkId: 'c-2',
      documentTitle: 'Restraint Policy',
      documentNumber: 'PP-9',
    });
    expect(ctx.citations[0].snippet).toContain('First passage.');
  });

  it('is deterministic — same input, identical output (AC3)', () => {
    const chunks = [chunk({ chunkId: 'c-1' }), chunk({ chunkId: 'c-2', content: 'Another.' })];
    expect(build().build(chunks)).toEqual(build().build(chunks));
  });

  it('dedups repeated chunkIds', () => {
    const ctx = build().build([chunk({ chunkId: 'dup' }), chunk({ chunkId: 'dup' })]);
    expect(ctx.citations).toHaveLength(1);
  });

  it('respects the character budget and keeps citations in sync (AC4)', () => {
    // Budget only fits one passage.
    const big = 'x'.repeat(300);
    const ctx = build(200).build([
      chunk({ chunkId: 'c-1', content: big }),
      chunk({ chunkId: 'c-2', content: big }),
      chunk({ chunkId: 'c-3', content: big }),
    ]);
    expect(ctx.contextText.length).toBeLessThanOrEqual(200);
    // Every citation must correspond to a passage present in contextText.
    for (const cite of ctx.citations) {
      expect(ctx.contextText).toContain(`[${cite.index}]`);
    }
    // At least one passage survived (first is always included, clipped).
    expect(ctx.citations.length).toBeGreaterThanOrEqual(1);
    expect(ctx.citations.length).toBeLessThan(3);
  });

  it('null documentNumber renders without parens', () => {
    const ctx = build().build([chunk({ documentNumber: null, versionNumber: null })]);
    // No number, no version → just the bare title on the header line.
    expect(ctx.contextText).toMatch(/\[1\] Seclusion Policy\n/);
  });

  it('source label is version-aware: names section, page, and version (Phase 4)', () => {
    const ctx = build().build([
      chunk({
        documentNumber: 'PP-42',
        versionNumber: 3,
        sectionIdentifier: 'Policy 705',
        sectionTitle: 'Seclusion',
        pageStart: 4,
        pageEnd: 5,
      }),
    ]);
    // e.g. "[1] Seclusion Policy (PP-42) · § Policy 705 Seclusion · pp. 4–5 · v3"
    expect(ctx.contextText).toContain('Seclusion Policy (PP-42)');
    expect(ctx.contextText).toContain('§ Policy 705 Seclusion');
    expect(ctx.contextText).toContain('pp. 4–5');
    expect(ctx.contextText).toContain('v3');
  });

  it('surfaces version-aware citation fields (Phase 4)', () => {
    const eff = new Date('2024-01-15T00:00:00.000Z');
    const ctx = build().build([
      chunk({
        versionNumber: 2,
        effectiveDate: eff,
        sectionIdentifier: 'Policy 705',
        sectionTitle: 'Seclusion',
        pageStart: 4,
        pageEnd: 4,
      }),
    ]);
    const c = ctx.citations[0];
    expect(c.versionNumber).toBe(2);
    expect(c.effectiveDate).toBe(eff.toISOString());
    expect(c.sectionIdentifier).toBe('Policy 705');
    expect(c.sectionTitle).toBe('Seclusion');
    expect(c.pageStart).toBe(4);
    expect(c.pageEnd).toBe(4);
  });
});
