import { RetrieverService } from './retriever.service';
import type { EmbeddingProvider } from './embedding-provider';
import type { RagConfigService } from './rag-config.service';
import type { EmbeddingCache } from './embedding-cache.service';
import type { DocumentAccessService } from '../documents/document-access.service';

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
    ...over,
  });

  const ftsRow = (over: Record<string, unknown> = {}) => ({
    chunkId: 'c-fts-1',
    documentId: 'doc-fts-1',
    versionId: 'v-cur-fts-1',
    chunkIndex: 0,
    content: 'Section 504 of the Rehabilitation Act of 1973 prohibits discrimination...',
    rank: 0.66,
    ...over,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const makePrisma = (): any => ({
    $queryRaw: jest.fn(),
    document: { findMany: jest.fn() },
  });

  const makeProvider = (over: Partial<EmbeddingProvider> = {}): EmbeddingProvider => ({
    isConfigured: jest.fn().mockReturnValue(true),
    model: 'text-embedding-3-small',
    dimensions: 1536,
    embed: jest.fn(async () => [new Array(1536).fill(0.1)]),
    ...over,
  });

  const makeConfig = (): RagConfigService =>
    ({
      retrievalTopK: 8,
      retrievalCandidatePool: 40,
      ftsCandidatePool: 40,
      rrfK: 60,
      retrievalMaxDistance: 0.72,
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
  ) => new RetrieverService(prisma as never, access, config, provider, cache);

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

    const hits = await svc.retrieve('anything');

    // Both $queryRaw calls happened regardless of the vector leg being empty —
    // this is the architectural fix: FTS is never skipped/gated by vector's output.
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(hits).toHaveLength(1);
  });
});
