import { EmbeddingService } from './embedding.service';
import { ChunkingService } from './chunking.service';
import { StructureDetectorService } from './structure-detector.service';
import { StructureAwareChunkingService } from './structure-aware-chunking.service';
import type { EmbeddingProvider } from './embedding-provider';
import type { RagConfigService } from './rag-config.service';

/**
 * Unit tests for the embedding worker. Prisma, the provider, and audit are
 * hand-rolled mocks (repo convention — see document-extraction.service.spec.ts).
 * The chunker is the REAL ChunkingService (pure, deterministic) so we test the
 * true chunk→embed→upsert wiring, not a stubbed chunk shape.
 */
describe('EmbeddingService', () => {
  const DONE_TEXT = 'First paragraph of policy text.\n\nSecond paragraph with more detail.';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const makePrisma = (versionOver: Record<string, unknown> = {}): any => {
    const version = {
      id: 'v-1',
      documentId: 'doc-1',
      extractionStatus: 'done',
      extractedText: DONE_TEXT,
      ...versionOver,
    };
    const executeRaw = jest.fn().mockResolvedValue(1);
    return {
      _version: version,
      _executeRaw: executeRaw,
      documentVersion: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue(version),
        update: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([{ id: 'v-1' }]),
      },
      // Existing chunks for the safe-reprocessing guard. Default [] → content is
      // "changed" vs the new chunks, so the normal embed+replace path runs (the
      // behavior every pre-Phase-2 test asserts). A test can override this to
      // simulate an unchanged version and exercise the skip-reembed path.
      documentChunk: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      // $transaction(cb) runs the callback with a tx that shares $executeRaw.
      $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({ $executeRaw: executeRaw }),
      ),
    };
  };

  const makeProvider = (over: Partial<EmbeddingProvider> = {}): EmbeddingProvider => ({
    isConfigured: jest.fn().mockReturnValue(true),
    model: 'text-embedding-3-small',
    dimensions: 1536,
    embed: jest.fn(async (texts: string[]) => texts.map(() => new Array(1536).fill(0.1))),
    ...over,
  });

  const makeConfig = (): RagConfigService =>
    ({
      chunkMaxTokens: 500,
      chunkOverlapTokens: 60,
      embeddingBatchSize: 96,
    }) as unknown as RagConfigService;

  const makeAudit = () => ({ record: jest.fn().mockResolvedValue('ae-1') });

  const build = (prisma: unknown, provider: EmbeddingProvider, audit: unknown) =>
    new EmbeddingService(
      prisma as never,
      // Real structure-aware chunker over the real token chunker + detector, so we
      // test the true chunk→embed→upsert wiring (including structural metadata).
      new StructureAwareChunkingService(new ChunkingService(), new StructureDetectorService()),
      makeConfig(),
      audit as never,
      provider,
    );

  it('claims, chunks, embeds, upserts chunks, marks done, and audits (AC6)', async () => {
    const prisma = makePrisma();
    const provider = makeProvider();
    const audit = makeAudit();
    const svc = build(prisma, provider, audit);

    await expect(svc.embedVersion('v-1')).resolves.toBe('done');

    // Compare-and-swap claim over the claimable states, bumping the attempt counter.
    const claim = prisma.documentVersion.updateMany.mock.calls[0][0];
    expect(claim.where.id).toBe('v-1');
    expect(claim.where.OR).toEqual(
      expect.arrayContaining([
        { embeddingStatus: 'pending' },
        { embeddingStatus: 'failed', embeddingAttempts: { lt: expect.any(Number) } },
        { embeddingStatus: 'processing', embeddingStartedAt: { lt: expect.any(Date) } },
      ]),
    );
    expect(claim.data.embeddingStatus).toBe('processing');
    expect(claim.data.embeddingAttempts).toEqual({ increment: 1 });

    // Provider was called with chunk text.
    expect(provider.embed).toHaveBeenCalled();
    // A transaction ran (delete + inserts).
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // The DELETE + at least one INSERT ran on the tx.
    expect(prisma._executeRaw.mock.calls.length).toBeGreaterThanOrEqual(2);

    // Final status update → done + embeddedAt + cleared retry budget.
    const finalUpdate = prisma.documentVersion.update.mock.calls.at(-1)[0];
    expect(finalUpdate.data.embeddingStatus).toBe('done');
    expect(finalUpdate.data.embeddingAttempts).toBe(0);
    expect(finalUpdate.data.embeddedAt).toBeInstanceOf(Date);

    // Audit of the successful index.
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'embedding.indexed', versionId: 'v-1', source: 'system' }),
    );
  });

  it('returns null when the version cannot be claimed (another worker won)', async () => {
    const prisma = makePrisma();
    prisma.documentVersion.updateMany.mockResolvedValueOnce({ count: 0 });
    const provider = makeProvider();
    const svc = build(prisma, provider, makeAudit());

    await expect(svc.embedVersion('v-1')).resolves.toBeNull();
    expect(provider.embed).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('skips with ZERO egress when the provider is not configured (AC5/security)', async () => {
    const prisma = makePrisma();
    const provider = makeProvider({ isConfigured: jest.fn().mockReturnValue(false) });
    const svc = build(prisma, provider, makeAudit());

    await expect(svc.embedVersion('v-1')).resolves.toBe('skipped');
    expect(provider.embed).not.toHaveBeenCalled(); // no OpenAI call
    expect(prisma.$transaction).not.toHaveBeenCalled(); // no chunks written
    const update = prisma.documentVersion.update.mock.calls.at(-1)[0];
    expect(update.data.embeddingStatus).toBe('skipped');
  });

  it('skips when extraction is not done (AC9)', async () => {
    const prisma = makePrisma({ extractionStatus: 'failed' });
    const provider = makeProvider();
    const svc = build(prisma, provider, makeAudit());

    await expect(svc.embedVersion('v-1')).resolves.toBe('skipped');
    expect(provider.embed).not.toHaveBeenCalled();
  });

  it('skips when there is no extracted text (AC9)', async () => {
    const prisma = makePrisma({ extractedText: '   ' });
    const provider = makeProvider();
    const svc = build(prisma, provider, makeAudit());

    await expect(svc.embedVersion('v-1')).resolves.toBe('skipped');
    expect(provider.embed).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('marks failed and does NOT write chunks when the provider throws (AC7)', async () => {
    const prisma = makePrisma();
    const provider = makeProvider({
      embed: jest.fn().mockRejectedValue(new Error('OpenAI 500')),
    });
    const audit = makeAudit();
    const svc = build(prisma, provider, audit);

    await expect(svc.embedVersion('v-1')).resolves.toBe('failed');
    // Transaction (chunk write) never ran because embed threw first.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    const update = prisma.documentVersion.update.mock.calls.at(-1)[0];
    expect(update.data.embeddingStatus).toBe('failed');
    expect(update.data.embeddingError).toContain('OpenAI 500');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'embedding.failed', versionId: 'v-1' }),
    );
  });

  it('re-index is idempotent: DELETEs prior chunks before inserting (AC8)', async () => {
    const prisma = makePrisma();
    const provider = makeProvider();
    const svc = build(prisma, provider, makeAudit());

    await svc.embedVersion('v-1');

    // First raw statement inside the tx is the DELETE for this version.
    const firstRaw = prisma._executeRaw.mock.calls[0][0];
    // Prisma tagged-template call: first arg is the template-strings array.
    const sql = Array.isArray(firstRaw) ? firstRaw.join('') : String(firstRaw);
    expect(sql).toMatch(/DELETE FROM .*DocumentChunk/i);
  });

  it('INSERT carries the structural metadata columns (RAG-P7/Option A)', async () => {
    const prisma = makePrisma();
    const provider = makeProvider();
    const svc = build(prisma, provider, makeAudit());

    await svc.embedVersion('v-1');

    // The INSERT statements are every raw call after the leading DELETE.
    const insertCall = prisma._executeRaw.mock.calls.find((call: unknown[]) => {
      const raw = call[0];
      const sql = Array.isArray(raw) ? raw.join('') : String(raw);
      return /INSERT INTO .*DocumentChunk/i.test(sql);
    });
    expect(insertCall).toBeDefined();
    const raw = insertCall![0];
    const sql = Array.isArray(raw) ? raw.join('') : String(raw);
    // Every new structural column must be present in the column list so the
    // Phase-2 detector only has to POPULATE TextChunk, never re-touch this INSERT.
    for (const col of [
      'sectionType',
      'sectionIdentifier',
      'normalizedSectionIdentifier',
      'sectionTitle',
      'headingPath',
      'pageStart',
      'pageEnd',
      'metadata',
    ]) {
      expect(sql).toContain(`"${col}"`);
    }
  });

  it('a chunk with no structural fields defaults headingPath=[] and metadata={} (unstructured)', async () => {
    const prisma = makePrisma();
    const provider = makeProvider();
    const svc = build(prisma, provider, makeAudit());

    await svc.embedVersion('v-1');

    // The plain chunker never sets structural fields, so the bound params for
    // headingPath / metadata must be a real empty array / '{}' — never null/
    // undefined (the DB columns are NOT NULL DEFAULT). Prisma tagged-template
    // interpolations arrive as the trailing args of the $executeRaw call.
    const insertCall = prisma._executeRaw.mock.calls.find((call: unknown[]) => {
      const rawArg = call[0];
      const sql = Array.isArray(rawArg) ? rawArg.join('') : String(rawArg);
      return /INSERT INTO .*DocumentChunk/i.test(sql);
    });
    const params = (insertCall as unknown[]).slice(1);
    // headingPath is passed as an actual array param.
    expect(params).toContainEqual([]);
    // metadata is passed as the JSON string '{}' (cast to ::jsonb in SQL).
    expect(params).toContain('{}');
  });

  it('never throws on failure — returns a terminal status instead (AC7/AC10)', async () => {
    const prisma = makePrisma();
    prisma.documentVersion.update.mockResolvedValue({});
    const provider = makeProvider({ embed: jest.fn().mockRejectedValue(new Error('boom')) });
    const svc = build(prisma, provider, makeAudit());

    // Must resolve (not reject) so the extraction hook's fire-and-forget is safe.
    await expect(svc.embedVersion('v-1')).resolves.toBe('failed');
  });

  describe('safe reprocessing (Phase 2)', () => {
    it('does NOT re-embed when chunk content + model are unchanged (metadata-only refresh)', async () => {
      const prisma = makePrisma();
      const provider = makeProvider();
      // Precompute the chunks the real structure-aware chunker will produce for
      // DONE_TEXT, and return them as the "existing" rows so content matches exactly.
      const { ChunkingService: CS } = await import('./chunking.service');
      const { StructureDetectorService: SDS } = await import('./structure-detector.service');
      const { StructureAwareChunkingService: SACS } = await import(
        './structure-aware-chunking.service'
      );
      const expectedChunks = new SACS(new CS(), new SDS()).chunk(DONE_TEXT, {
        maxTokens: 500,
        overlapTokens: 60,
      });
      prisma.documentChunk.findMany.mockResolvedValueOnce(
        expectedChunks.map((c) => ({ content: c.content, embeddingModel: provider.model })),
      );

      const svc = build(prisma, provider, makeAudit());
      await expect(svc.embedVersion('v-1')).resolves.toBe('done');

      // The embedding provider was NEVER called (no OpenAI cost).
      expect(provider.embed).not.toHaveBeenCalled();
      // No delete-then-insert transaction ran; only the metadata-refresh UPDATEs.
      const rawSql = prisma._executeRaw.mock.calls.map((c: unknown[]) => {
        const raw = c[0];
        return Array.isArray(raw) ? raw.join('') : String(raw);
      });
      expect(rawSql.some((s: string) => /DELETE FROM .*DocumentChunk/i.test(s))).toBe(false);
      expect(rawSql.some((s: string) => /UPDATE .*DocumentChunk/i.test(s))).toBe(true);
    });

    it('DOES re-embed when content changed (existing chunks differ)', async () => {
      const prisma = makePrisma();
      const provider = makeProvider();
      // Existing chunk content differs → the guard must fall through to embed.
      prisma.documentChunk.findMany.mockResolvedValueOnce([
        { content: 'totally different old content', embeddingModel: provider.model },
      ]);
      const svc = build(prisma, provider, makeAudit());

      await expect(svc.embedVersion('v-1')).resolves.toBe('done');
      expect(provider.embed).toHaveBeenCalled();
      expect(prisma.$transaction).toHaveBeenCalled();
    });
  });

  describe('embedPending (backfill)', () => {
    it('re-queues non-done published versions and processes a batch', async () => {
      const prisma = makePrisma();
      prisma.documentVersion.updateMany.mockResolvedValueOnce({ count: 3 }); // requeue
      // subsequent updateMany calls are the per-version claims (count: 1)
      const provider = makeProvider();
      const svc = build(prisma, provider, makeAudit());

      const result = await svc.embedPending();

      const requeue = prisma.documentVersion.updateMany.mock.calls[0][0];
      expect(requeue.where.embeddingStatus).toEqual({ not: 'done' });
      expect(requeue.where.extractionStatus).toBe('done');
      expect(requeue.where.document).toEqual({ deletedAt: null, status: 'published' });
      expect(result.queued).toBe(3);
      expect(result.processed).toBeGreaterThanOrEqual(0);
    });
  });
});
