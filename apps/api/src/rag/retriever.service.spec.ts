import { RetrieverService } from './retriever.service';
import { StructureDetectorService } from './structure-detector.service';
import type { EmbeddingProvider } from './embedding-provider';
import type { RagConfigService } from './rag-config.service';
import type { EmbeddingCache } from './embedding-cache.service';
import type { DocumentAccessService } from '../documents/document-access.service';

/** Default structural fields (null/[]) so a plain chunk row is "unstructured". */
const NO_STRUCTURE = {
  sectionType: null,
  sectionIdentifier: null,
  normalizedSectionIdentifier: null,
  sectionTitle: null,
  headingPath: [] as string[],
  pageStart: null,
  pageEnd: null,
};

/**
 * Unit tests for the hybrid retriever. Prisma, the provider, config, and access
 * are hand-rolled mocks. The two raw SQL calls (vector KNN, FTS) run
 * independently (Promise.all) and are sequenced with mockResolvedValueOnce in
 * call order; the Prisma mock ignores the SQL and returns queued rows (repo
 * convention — see documents.service.spec / public-documents.service.spec).
 */
describe('RetrieverService', () => {
  const vecRow = (over: Record<string, unknown> = {}) => ({
    chunkId: 'c-1',
    documentId: 'doc-1',
    versionId: 'v-cur-1',
    chunkIndex: 0,
    content: 'seclusion policy chunk',
    distance: 0.1,
    ...NO_STRUCTURE,
    ...over,
  });

  const ftsRow = (over: Record<string, unknown> = {}) => ({
    chunkId: 'c-fts-1',
    documentId: 'doc-fts-1',
    versionId: 'v-cur-fts-1',
    chunkIndex: 0,
    content: 'Section 504 of the Rehabilitation Act of 1973 prohibits discrimination...',
    rank: 0.66,
    ...NO_STRUCTURE,
    ...over,
  });

  const exactRow = (over: Record<string, unknown> = {}) => ({
    chunkId: 'c-exact-1',
    documentId: 'doc-exact-1',
    versionId: 'v-cur-exact-1',
    chunkIndex: 0,
    content: 'Policy 705. Restraint may be used only as a last resort.',
    ...NO_STRUCTURE,
    sectionType: 'policy',
    sectionIdentifier: 'Policy 705',
    normalizedSectionIdentifier: 'policy 705',
    ...over,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const makePrisma = (): any => ({
    // Default to [] so any leg not explicitly queued (e.g. the exact-identifier leg
    // when a test's query happens to name an identifier) is harmless. Tests that
    // assert on specific legs use mockResolvedValueOnce, which takes precedence.
    $queryRaw: jest.fn().mockResolvedValue([]),
    // documentChunk.findMany backs adjacent-chunk expansion; default [] = no neighbors.
    documentChunk: { findMany: jest.fn().mockResolvedValue([]) },
    document: { findMany: jest.fn() },
    // documentVersion.findMany backs version-aware citation hydration (Phase 4);
    // default [] so versionNumber resolves to null when a test doesn't queue rows.
    documentVersion: { findMany: jest.fn().mockResolvedValue([]) },
  });

  const makeProvider = (over: Partial<EmbeddingProvider> = {}): EmbeddingProvider => ({
    isConfigured: jest.fn().mockReturnValue(true),
    model: 'text-embedding-3-small',
    dimensions: 1536,
    embed: jest.fn(async () => [new Array(1536).fill(0.1)]),
    ...over,
  });

  const makeConfig = (over: Record<string, unknown> = {}): RagConfigService =>
    ({
      retrievalTopK: 8,
      retrievalCandidatePool: 40,
      ftsCandidatePool: 40,
      rrfK: 60,
      retrievalMaxDistance: 0.72,
      exactCandidatePool: 20,
      exactMatchBoost: 1.0,
      // Default OFF in most tests so the two-leg call ordering and assertions hold;
      // the adjacent-expansion test overrides this to 1.
      adjacentExpansion: 0,
      ...over,
    }) as unknown as RagConfigService;

  const makeAccess = (): DocumentAccessService =>
    ({ buildListWhere: jest.fn().mockResolvedValue({}) }) as unknown as DocumentAccessService;

  // Stub cache that always misses (so the provider.embed assertions still hold).
  const makeCache = (): EmbeddingCache =>
    ({ get: jest.fn().mockReturnValue(undefined), set: jest.fn() }) as unknown as EmbeddingCache;

  const build = (
    prisma: unknown,
    provider: EmbeddingProvider,
    access: DocumentAccessService = makeAccess(),
    config: RagConfigService = makeConfig(),
    cache: EmbeddingCache = makeCache(),
  ) =>
    new RetrieverService(
      prisma as never,
      access,
      config,
      provider,
      cache,
      new StructureDetectorService(),
    );

  it('returns [] with ZERO egress when the provider is not configured (AC4)', async () => {
    const prisma = makePrisma();
    const provider = makeProvider({ isConfigured: jest.fn().mockReturnValue(false) });
    const svc = build(prisma, provider);

    await expect(svc.retrieve('anything', { user: { id: 'u1' } as never })).resolves.toEqual([]);
    expect(provider.embed).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('returns [] for an empty query without embedding (AC5)', async () => {
    const prisma = makePrisma();
    const provider = makeProvider();
    const svc = build(prisma, provider);

    await expect(svc.retrieve('   ')).resolves.toEqual([]);
    expect(provider.embed).not.toHaveBeenCalled();
  });

  it('retrieves current-version chunks, fuses, ACL-filters, hydrates (AC1/AC2)', async () => {
    const prisma = makePrisma();
    // Both legs run independently (Promise.all): 1) vector KNN rows, 2) FTS chunk rows
    prisma.$queryRaw
      .mockResolvedValueOnce([vecRow({ chunkId: 'c-1', documentId: 'doc-1', distance: 0.05 })])
      .mockResolvedValueOnce([ftsRow({ chunkId: 'c-1', documentId: 'doc-1' })]); // same chunk, both legs agree
    // ACL filter: doc-1 is visible
    prisma.document.findMany
      .mockResolvedValueOnce([{ id: 'doc-1' }]) // filterVisible
      .mockResolvedValueOnce([{ id: 'doc-1', title: 'Seclusion Policy', documentNumber: 'PP-42' }]); // hydrate
    const provider = makeProvider();
    const svc = build(prisma, provider);

    const hits = await svc.retrieve('seclusion', { user: { id: 'u1' } as never });

    expect(provider.embed).toHaveBeenCalledWith(['seclusion']);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      documentId: 'doc-1',
      chunkId: 'c-1',
      versionId: 'v-cur-1',
      content: 'seclusion policy chunk',
      documentTitle: 'Seclusion Policy',
      documentNumber: 'PP-42',
    });
    // score = 1 - distance (chunk was found by the vector leg, so distance wins)
    expect(hits[0].score).toBeCloseTo(0.95, 5);
  });

  it('surfaces a chunk found ONLY by full-text search — vector search never ranked it (the hybrid fix)', async () => {
    const prisma = makePrisma();
    // Vector leg finds nothing relevant for this document at all (e.g. a generic
    // "what is Section 504..." embeds far from the HIV-policy chunk that quotes
    // it) — but FTS independently ranks the exact chunk top via lexical match.
    prisma.$queryRaw
      .mockResolvedValueOnce([]) // vector: no candidates survive (or none at all)
      .mockResolvedValueOnce([ftsRow()]); // FTS: independent hit, not gated by vector's output
    prisma.document.findMany
      .mockResolvedValueOnce([{ id: 'doc-fts-1' }]) // filterVisible
      .mockResolvedValueOnce([
        { id: 'doc-fts-1', title: 'Master Policy and Procedures', documentNumber: '512' },
      ]);
    const provider = makeProvider();
    const svc = build(prisma, provider);

    const hits = await svc.retrieve('what is Section 504 of the Rehabilitation Act of 1973?', {
      user: { id: 'u1' } as never,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      documentId: 'doc-fts-1',
      chunkId: 'c-fts-1',
      content: 'Section 504 of the Rehabilitation Act of 1973 prohibits discrimination...',
    });
    // No vector distance for this chunk — score falls back to the RRF fused score
    // (1/(k+0) since it's rank 0 in the FTS leg and absent from the vector leg).
    expect(hits[0].score).toBeCloseTo(1 / 60, 5);
  });

  it('ranks a chunk found by BOTH legs above one found by only one leg (RRF rewards agreement)', async () => {
    const prisma = makePrisma();
    prisma.$queryRaw
      .mockResolvedValueOnce([
        vecRow({ chunkId: 'c-both', documentId: 'doc-both', distance: 0.3 }),
        vecRow({ chunkId: 'c-vec-only', documentId: 'doc-vec-only', distance: 0.1 }), // closer, but FTS-silent
      ])
      .mockResolvedValueOnce([ftsRow({ chunkId: 'c-both', documentId: 'doc-both', rank: 0.5 })]);
    prisma.document.findMany
      .mockResolvedValueOnce([{ id: 'doc-both' }, { id: 'doc-vec-only' }])
      .mockResolvedValueOnce([
        { id: 'doc-both', title: 'Both', documentNumber: null },
        { id: 'doc-vec-only', title: 'Vec Only', documentNumber: null },
      ]);
    const provider = makeProvider();
    const svc = build(prisma, provider);

    const hits = await svc.retrieve('query', { user: { id: 'u1' } as never });

    // c-both: rank 0 in vector (1/60) + rank 0 in FTS (1/60) = 2/60
    // c-vec-only: rank 1 in vector only (1/61)
    // 2/60 > 1/61, so c-both must rank first despite a worse cosine distance.
    expect(hits.map((h) => h.chunkId)).toEqual(['c-both', 'c-vec-only']);
  });

  it('excludes a document the ACL re-filter drops (confidential, no grant) (AC3)', async () => {
    const prisma = makePrisma();
    prisma.$queryRaw
      .mockResolvedValueOnce([
        vecRow({ chunkId: 'c-a', documentId: 'doc-secret', distance: 0.01 }), // top vector match
        vecRow({ chunkId: 'c-b', documentId: 'doc-ok', distance: 0.2 }),
      ])
      .mockResolvedValueOnce([]);
    // ACL filter removes doc-secret (not returned by findMany); only doc-ok visible.
    prisma.document.findMany
      .mockResolvedValueOnce([{ id: 'doc-ok' }])
      .mockResolvedValueOnce([{ id: 'doc-ok', title: 'Visible Doc', documentNumber: null }]);
    const provider = makeProvider();
    const access = makeAccess();
    const svc = build(prisma, provider, access);

    const hits = await svc.retrieve('secret thing', { user: { id: 'u1' } as never });

    // doc-secret was the closest vector hit but is filtered out by ACL.
    expect(hits.map((h) => h.documentId)).toEqual(['doc-ok']);
    expect(access.buildListWhere).toHaveBeenCalledWith({ id: 'u1' });
  });

  it('drops weak vector matches beyond the distance threshold on that leg only — a query with no FTS hit either returns empty', async () => {
    const prisma = makePrisma();
    // All candidate chunks are far (distance 0.9 > 0.72) on the vector leg, and
    // FTS independently finds nothing lexically relevant either — a genuinely
    // off-topic query (greeting, small talk) should still retrieve nothing.
    prisma.$queryRaw
      .mockResolvedValueOnce([
        vecRow({ chunkId: 'c-far', documentId: 'doc-x', distance: 0.9 }),
        vecRow({ chunkId: 'c-far2', documentId: 'doc-y', distance: 0.95 }),
      ])
      .mockResolvedValueOnce([]); // FTS: no lexical match for a greeting
    const provider = makeProvider();
    const svc = build(prisma, provider);

    const hits = await svc.retrieve('Hey', { user: { id: 'u1' } as never });

    expect(hits).toEqual([]); // nothing relevant on either leg → empty
    expect(prisma.document.findMany).not.toHaveBeenCalled();
  });

  it('a strong FTS-only match surfaces even though the vector leg found nothing relevant (true hybrid, not vector-gated)', async () => {
    const prisma = makePrisma();
    prisma.$queryRaw
      .mockResolvedValueOnce([vecRow({ chunkId: 'c-far', documentId: 'doc-x', distance: 0.95 })]) // vector: too far, dropped
      .mockResolvedValueOnce([ftsRow({ chunkId: 'c-lex', documentId: 'doc-lex' })]); // FTS: independent, strong lexical hit
    prisma.document.findMany
      .mockResolvedValueOnce([{ id: 'doc-lex' }])
      .mockResolvedValueOnce([{ id: 'doc-lex', title: 'Policy 512', documentNumber: '512' }]);
    const provider = makeProvider();
    const svc = build(prisma, provider);

    const hits = await svc.retrieve('Policy 512', { user: { id: 'u1' } as never });

    expect(hits.map((h) => h.chunkId)).toEqual(['c-lex']);
  });

  it('dedupes a chunk that both legs return, without double-counting it', async () => {
    const prisma = makePrisma();
    prisma.$queryRaw
      .mockResolvedValueOnce([vecRow({ chunkId: 'c-1', documentId: 'doc-1', distance: 0.1 })])
      .mockResolvedValueOnce([ftsRow({ chunkId: 'c-1', documentId: 'doc-1' })]);
    prisma.document.findMany
      .mockResolvedValueOnce([{ id: 'doc-1' }])
      .mockResolvedValueOnce([{ id: 'doc-1', title: 'T', documentNumber: null }]);
    const provider = makeProvider();
    const svc = build(prisma, provider);

    const hits = await svc.retrieve('query', { user: { id: 'u1' } as never });

    expect(hits).toHaveLength(1);
  });

  it('returns [] when no candidates match on either leg (AC5)', async () => {
    const prisma = makePrisma();
    prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const provider = makeProvider();
    const svc = build(prisma, provider);

    await expect(svc.retrieve('nomatch')).resolves.toEqual([]);
    expect(prisma.document.findMany).not.toHaveBeenCalled();
  });

  it('returns [] and does not throw when query embedding fails', async () => {
    const prisma = makePrisma();
    const provider = makeProvider({ embed: jest.fn().mockRejectedValue(new Error('rate limit')) });
    const svc = build(prisma, provider);

    await expect(svc.retrieve('boom')).resolves.toEqual([]);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('caps results at topK (AC6)', async () => {
    const prisma = makePrisma();
    // 5 vector chunks across 5 docs; topK override = 2.
    const rows = Array.from({ length: 5 }, (_, i) =>
      vecRow({ chunkId: `c-${i}`, documentId: `doc-${i}`, distance: 0.1 + i * 0.05 }),
    );
    prisma.$queryRaw.mockResolvedValueOnce(rows).mockResolvedValueOnce([]);
    prisma.document.findMany
      .mockResolvedValueOnce(rows.map((r) => ({ id: r.documentId }))) // all visible
      .mockResolvedValueOnce(
        rows.map((r) => ({ id: r.documentId, title: `T-${r.documentId}`, documentNumber: null })),
      );
    const provider = makeProvider();
    const svc = build(prisma, provider);

    const hits = await svc.retrieve('many', { user: { id: 'u1' } as never, topK: 2 });
    expect(hits).toHaveLength(2);
  });

  it('uses a cached query embedding instead of calling the provider (Phase 6 cache)', async () => {
    const prisma = makePrisma();
    prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const provider = makeProvider();
    // Cache hit → provider.embed must NOT be called.
    const cache = { get: jest.fn().mockReturnValue(new Array(1536).fill(0.5)), set: jest.fn() } as unknown as EmbeddingCache;
    const svc = build(prisma, provider, makeAccess(), makeConfig(), cache);

    await svc.retrieve('cached query', { user: { id: 'u1' } as never });

    expect(cache.get).toHaveBeenCalledWith('cached query', 'text-embedding-3-small');
    expect(provider.embed).not.toHaveBeenCalled();
  });

  it('populates the cache after a provider embed (cache miss then set)', async () => {
    const prisma = makePrisma();
    prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const provider = makeProvider();
    const cache = { get: jest.fn().mockReturnValue(undefined), set: jest.fn() } as unknown as EmbeddingCache;
    const svc = build(prisma, provider, makeAccess(), makeConfig(), cache);

    await svc.retrieve('fresh query', { user: { id: 'u1' } as never });

    expect(provider.embed).toHaveBeenCalledWith(['fresh query']);
    expect(cache.set).toHaveBeenCalledWith('fresh query', 'text-embedding-3-small', expect.any(Array));
  });

  it('uses the schema-qualified cosine operator and current-version filter in the KNN SQL (AC8)', async () => {
    const prisma = makePrisma();
    prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const provider = makeProvider();
    const svc = build(prisma, provider);

    await svc.retrieve('check sql');

    // First $queryRaw call is the vector KNN. Prisma.sql produces a parameterized
    // object; its `strings`/`sql` carries the literal SQL fragments.
    const firstCall = prisma.$queryRaw.mock.calls[0][0];
    const sql = JSON.stringify(firstCall);
    expect(sql).toMatch(/DocumentChunk/);
    expect(sql).toMatch(/currentVersionId/);
    expect(sql).toMatch(/OPERATOR/);
    expect(sql).toMatch(/published/);
  });

  it('runs FTS as a real chunk-level query — independent of vector search, scoped to current version', async () => {
    const prisma = makePrisma();
    prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const provider = makeProvider();
    const svc = build(prisma, provider);

    await svc.retrieve('Section 504');

    // Second $queryRaw call is the FTS leg.
    const secondCall = prisma.$queryRaw.mock.calls[1][0];
    const sql = JSON.stringify(secondCall);
    expect(sql).toMatch(/DocumentChunk/);
    expect(sql).toMatch(/searchVector/);
    expect(sql).toMatch(/currentVersionId/);
    expect(sql).toMatch(/published/);
    expect(sql).toMatch(/ts_rank_cd/);
  });

  it('runs both legs even when the vector leg returns nothing (FTS is not gated on vector results)', async () => {
    const prisma = makePrisma();
    prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([ftsRow()]);
    prisma.document.findMany
      .mockResolvedValueOnce([{ id: 'doc-fts-1' }])
      .mockResolvedValueOnce([{ id: 'doc-fts-1', title: 'T', documentNumber: null }]);
    const provider = makeProvider();
    const svc = build(prisma, provider);

    const hits = await svc.retrieve('anything'); // no identifier → no exact leg

    // Both $queryRaw calls happened regardless of the vector leg being empty —
    // this is the architectural fix: FTS is never skipped/gated by vector's output.
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(hits).toHaveLength(1);
  });

  describe('exact-identifier leg (Phase 3)', () => {
    it('does NOT run the exact leg for a plain semantic query (two legs only)', async () => {
      const prisma = makePrisma();
      prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      const svc = build(prisma, makeProvider());

      await svc.retrieve('what are the rules about restraint?');

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2); // vector + FTS, no exact
    });

    it('runs a THIRD exact-identifier leg when the query names an identifier', async () => {
      const prisma = makePrisma();
      prisma.$queryRaw
        .mockResolvedValueOnce([]) // vector
        .mockResolvedValueOnce([]) // fts
        .mockResolvedValueOnce([exactRow()]); // exact leg
      prisma.document.findMany
        .mockResolvedValueOnce([{ id: 'doc-exact-1' }])
        .mockResolvedValueOnce([{ id: 'doc-exact-1', title: 'Clinical Manual', documentNumber: null }]);
      const svc = build(prisma, makeProvider());

      const hits = await svc.retrieve('what does Policy 705 say?', { user: { id: 'u1' } as never });

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
      // The exact leg's SQL filters on normalizedSectionIdentifier via ANY(...).
      const exactSql = JSON.stringify(prisma.$queryRaw.mock.calls[2][0]);
      expect(exactSql).toMatch(/normalizedSectionIdentifier/);
      expect(exactSql).toMatch(/currentVersionId/);
      expect(exactSql).toMatch(/published/);
      expect(hits.map((h) => h.chunkId)).toContain('c-exact-1');
      expect(hits[0].exactMatch).toBe(true);
    });

    it('EXACT-match priority: the requested section outranks a closer semantic chunk', async () => {
      const prisma = makePrisma();
      // A vector chunk with a great cosine distance (0.02) from a DIFFERENT doc,
      // and the exact "Policy 705" chunk with no vector rank at all. The exact
      // boost must lift the requested section to the top.
      prisma.$queryRaw
        .mockResolvedValueOnce([vecRow({ chunkId: 'c-close', documentId: 'doc-other', distance: 0.02 })])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([exactRow({ chunkId: 'c-705', documentId: 'doc-manual' })]);
      prisma.document.findMany
        .mockResolvedValueOnce([{ id: 'doc-other' }, { id: 'doc-manual' }])
        .mockResolvedValueOnce([
          { id: 'doc-other', title: 'Other', documentNumber: null },
          { id: 'doc-manual', title: 'Manual', documentNumber: null },
        ]);
      const svc = build(prisma, makeProvider());

      const hits = await svc.retrieve('show me Policy 705', { user: { id: 'u1' } as never });

      expect(hits[0].chunkId).toBe('c-705'); // exact match wins despite worse "distance"
      expect(hits[0].exactMatch).toBe(true);
    });

    it('detects a bare "Section 504" query and normalizes it for the exact leg', async () => {
      const prisma = makePrisma();
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          exactRow({ chunkId: 'c-504', normalizedSectionIdentifier: '504', sectionIdentifier: '504', sectionType: 'section' }),
        ]);
      prisma.document.findMany
        .mockResolvedValueOnce([{ id: 'doc-exact-1' }])
        .mockResolvedValueOnce([{ id: 'doc-exact-1', title: 'Reg', documentNumber: null }]);
      const svc = build(prisma, makeProvider());

      const hits = await svc.retrieve('Section 504', { user: { id: 'u1' } as never });

      // The bound param array to the exact leg contains the normalized id "504".
      const exactCall = JSON.stringify(prisma.$queryRaw.mock.calls[2]);
      expect(exactCall).toMatch(/504/);
      expect(hits[0].chunkId).toBe('c-504');
    });
  });

  describe('adjacent-chunk expansion (Phase 3)', () => {
    it('pulls chunkIndex±1 neighbors within the same section around an anchor', async () => {
      const prisma = makePrisma();
      // One anchor at chunkIndex 5 in section "policy 705".
      prisma.$queryRaw
        .mockResolvedValueOnce([
          vecRow({
            chunkId: 'c-anchor',
            documentId: 'doc-1',
            versionId: 'v-1',
            chunkIndex: 5,
            distance: 0.1,
            sectionType: 'policy',
            normalizedSectionIdentifier: 'policy 705',
          }),
        ])
        .mockResolvedValueOnce([]);
      // Neighbors 4 and 6 in the same version + same section.
      prisma.documentChunk.findMany.mockResolvedValueOnce([
        { id: 'c-prev', documentId: 'doc-1', versionId: 'v-1', chunkIndex: 4, content: 'prev', sectionType: 'policy', sectionIdentifier: 'Policy 705', normalizedSectionIdentifier: 'policy 705', sectionTitle: null, headingPath: [], pageStart: null, pageEnd: null },
        { id: 'c-next', documentId: 'doc-1', versionId: 'v-1', chunkIndex: 6, content: 'next', sectionType: 'policy', sectionIdentifier: 'Policy 705', normalizedSectionIdentifier: 'policy 705', sectionTitle: null, headingPath: [], pageStart: null, pageEnd: null },
      ]);
      prisma.document.findMany
        .mockResolvedValueOnce([{ id: 'doc-1' }])
        .mockResolvedValueOnce([{ id: 'doc-1', title: 'Manual', documentNumber: null }]);
      const svc = build(prisma, makeProvider(), makeAccess(), makeConfig({ adjacentExpansion: 1 }));

      const hits = await svc.retrieve('restraint policy', { user: { id: 'u1' } as never });

      const ids = hits.map((h) => h.chunkId);
      expect(ids).toContain('c-anchor');
      expect(ids).toContain('c-prev');
      expect(ids).toContain('c-next');
      // Neighbors are flagged adjacent; the anchor is not.
      expect(hits.find((h) => h.chunkId === 'c-anchor')!.adjacent).toBe(false);
      expect(hits.find((h) => h.chunkId === 'c-prev')!.adjacent).toBe(true);
    });

    it('does NOT include a neighbor from a DIFFERENT section (respects boundaries)', async () => {
      const prisma = makePrisma();
      prisma.$queryRaw
        .mockResolvedValueOnce([
          vecRow({
            chunkId: 'c-anchor',
            documentId: 'doc-1',
            versionId: 'v-1',
            chunkIndex: 5,
            distance: 0.1,
            normalizedSectionIdentifier: 'policy 705',
          }),
        ])
        .mockResolvedValueOnce([]);
      // Neighbor 6 belongs to a DIFFERENT section (policy 706) → must be excluded.
      prisma.documentChunk.findMany.mockResolvedValueOnce([
        { id: 'c-other-section', documentId: 'doc-1', versionId: 'v-1', chunkIndex: 6, content: 'other', sectionType: 'policy', sectionIdentifier: 'Policy 706', normalizedSectionIdentifier: 'policy 706', sectionTitle: null, headingPath: [], pageStart: null, pageEnd: null },
      ]);
      prisma.document.findMany
        .mockResolvedValueOnce([{ id: 'doc-1' }])
        .mockResolvedValueOnce([{ id: 'doc-1', title: 'M', documentNumber: null }]);
      const svc = build(prisma, makeProvider(), makeAccess(), makeConfig({ adjacentExpansion: 1 }));

      const hits = await svc.retrieve('policy', { user: { id: 'u1' } as never });

      expect(hits.map((h) => h.chunkId)).not.toContain('c-other-section');
    });
  });

  it('produces deterministic ordering (ties broken by documentId, chunkIndex)', async () => {
    const prisma = makePrisma();
    // Two chunks with identical fused score (each found by one leg at rank 0).
    prisma.$queryRaw
      .mockResolvedValueOnce([vecRow({ chunkId: 'c-b', documentId: 'doc-z', distance: 0.5 })])
      .mockResolvedValueOnce([ftsRow({ chunkId: 'c-a', documentId: 'doc-a', rank: 0.5 })]);
    prisma.document.findMany
      .mockResolvedValueOnce([{ id: 'doc-z' }, { id: 'doc-a' }])
      .mockResolvedValueOnce([
        { id: 'doc-z', title: 'Z', documentNumber: null },
        { id: 'doc-a', title: 'A', documentNumber: null },
      ]);
    const svc = build(prisma, makeProvider());

    const hits = await svc.retrieve('tie query');
    // Equal RRF (1/60 each): tie broken by documentId asc → doc-a before doc-z.
    expect(hits.map((h) => h.documentId)).toEqual(['doc-a', 'doc-z']);
  });

  describe('document diversity & per-document caps (Phase 4)', () => {
    it('caps chunks per document so one large doc cannot monopolize a broad query', async () => {
      const prisma = makePrisma();
      // doc-big has 5 top-ranked chunks; doc-small has 1. Cap = 2 per document.
      const bigChunks = Array.from({ length: 5 }, (_, i) =>
        vecRow({ chunkId: `big-${i}`, documentId: 'doc-big', chunkIndex: i, distance: 0.05 + i * 0.01 }),
      );
      prisma.$queryRaw
        .mockResolvedValueOnce([...bigChunks, vecRow({ chunkId: 'small-0', documentId: 'doc-small', distance: 0.2 })])
        .mockResolvedValueOnce([]);
      prisma.document.findMany
        .mockResolvedValueOnce([{ id: 'doc-big' }, { id: 'doc-small' }])
        .mockResolvedValueOnce([
          { id: 'doc-big', title: 'Big', documentNumber: null },
          { id: 'doc-small', title: 'Small', documentNumber: null },
        ]);
      const svc = build(prisma, makeProvider(), makeAccess(), makeConfig({ maxChunksPerDocument: 2 }));

      const hits = await svc.retrieve('broad query', { user: { id: 'u1' } as never });

      const bigCount = hits.filter((h) => h.documentId === 'doc-big').length;
      expect(bigCount).toBeLessThanOrEqual(2); // capped
      // The small document still surfaces despite lower raw scores.
      expect(hits.some((h) => h.documentId === 'doc-small')).toBe(true);
    });

    it('EXACT-section requests BYPASS the per-document cap (assemble the whole section)', async () => {
      const prisma = makePrisma();
      // 4 exact-leg chunks all in doc-manual, section "policy 705". Cap = 2, but the
      // exact bypass must let all 4 through so the whole section is assembled.
      const exactChunks = Array.from({ length: 4 }, (_, i) =>
        exactRow({ chunkId: `p705-${i}`, documentId: 'doc-manual', chunkIndex: i }),
      );
      prisma.$queryRaw
        .mockResolvedValueOnce([]) // vector
        .mockResolvedValueOnce([]) // fts
        .mockResolvedValueOnce(exactChunks); // exact leg
      prisma.document.findMany
        .mockResolvedValueOnce([{ id: 'doc-manual' }])
        .mockResolvedValueOnce([{ id: 'doc-manual', title: 'Manual', documentNumber: null }]);
      const svc = build(prisma, makeProvider(), makeAccess(), makeConfig({ maxChunksPerDocument: 2, adjacentExpansion: 0 }));

      const hits = await svc.retrieve('show me all of Policy 705', { user: { id: 'u1' } as never });

      // All 4 exact chunks survive despite the cap of 2.
      expect(hits.filter((h) => h.exactMatch).length).toBe(4);
    });
  });

  describe('duplicate-identifier detection & version-aware citations (Phase 4)', () => {
    it('reports a collision when the same identifier is in TWO visible documents', async () => {
      const prisma = makePrisma();
      // "Policy 705" exists in two different manuals (org A and org B style).
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          exactRow({ chunkId: 'a-705', documentId: 'doc-a' }),
          exactRow({ chunkId: 'b-705', documentId: 'doc-b' }),
        ]);
      prisma.document.findMany
        .mockResolvedValueOnce([{ id: 'doc-a' }, { id: 'doc-b' }])
        .mockResolvedValueOnce([
          { id: 'doc-a', title: 'Manual A', documentNumber: 'A-1', effectiveDate: null },
          { id: 'doc-b', title: 'Manual B', documentNumber: 'B-1', effectiveDate: null },
        ]);
      const svc = build(prisma, makeProvider(), makeAccess(), makeConfig({ adjacentExpansion: 0 }));

      const result = await svc.retrieveWithIntelligence('Policy 705', { user: { id: 'u1' } as never });

      expect(result.collisions).toHaveLength(1);
      expect(result.collisions[0].normalizedIdentifier).toBe('policy 705');
      expect(result.collisions[0].documents.map((d) => d.documentId).sort()).toEqual(['doc-a', 'doc-b']);
    });

    it('reports NO collision when the identifier is in only ONE document', async () => {
      const prisma = makePrisma();
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([exactRow({ chunkId: 'a-705', documentId: 'doc-a' })]);
      prisma.document.findMany
        .mockResolvedValueOnce([{ id: 'doc-a' }])
        .mockResolvedValueOnce([{ id: 'doc-a', title: 'Manual A', documentNumber: null, effectiveDate: null }]);
      const svc = build(prisma, makeProvider(), makeAccess(), makeConfig({ adjacentExpansion: 0 }));

      const result = await svc.retrieveWithIntelligence('Policy 705', { user: { id: 'u1' } as never });
      expect(result.collisions).toHaveLength(0);
    });

    it('hydrates versionNumber and effectiveDate for version-aware citations', async () => {
      const prisma = makePrisma();
      const eff = new Date('2024-06-01T00:00:00.000Z');
      prisma.$queryRaw
        .mockResolvedValueOnce([vecRow({ chunkId: 'c-1', documentId: 'doc-1', versionId: 'v-1', distance: 0.1 })])
        .mockResolvedValueOnce([]);
      prisma.document.findMany
        .mockResolvedValueOnce([{ id: 'doc-1' }])
        .mockResolvedValueOnce([{ id: 'doc-1', title: 'Manual', documentNumber: 'M-1', effectiveDate: eff }]);
      prisma.documentVersion.findMany.mockResolvedValueOnce([{ id: 'v-1', versionNumber: 3 }]);
      const svc = build(prisma, makeProvider(), makeAccess(), makeConfig({ adjacentExpansion: 0 }));

      const hits = await svc.retrieve('restraint', { user: { id: 'u1' } as never });
      expect(hits[0].versionNumber).toBe(3);
      expect(hits[0].effectiveDate).toEqual(eff);
    });
  });
});
