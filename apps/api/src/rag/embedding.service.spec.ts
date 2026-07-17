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
        // Backs pruneOtherVersionChunks (delete stale prior-version chunks after embed).
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
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

  it('batches inserts and raises the tx timeout for a LARGE document (regression: 5s tx timeout)', async () => {
    // A big document produces many chunks. Regression guard for the real failure
    // "Transaction already closed (5000ms)" on a ~700-chunk manual: inserts must be
    // BATCHED (few INSERT round-trips, not one per chunk) inside a transaction whose
    // timeout is raised well above Prisma's 5s default.
    const bigText = 'A meaningful policy sentence about restraint and safety. '.repeat(4000);
    const prisma = makePrisma({ extractedText: bigText });
    const provider = makeProvider();
    const svc = build(prisma, provider, makeAudit());

    await expect(svc.embedVersion('v-1')).resolves.toBe('done');

    // The transaction was called with an explicit timeout option well above 5s.
    const txCall = prisma.$transaction.mock.calls[0];
    expect(txCall[1]).toMatchObject({ timeout: expect.any(Number) });
    expect(txCall[1].timeout).toBeGreaterThan(5000);

    // Inserts are batched: the number of INSERT statements is far below the number
    // of chunks (1 DELETE + a handful of batched INSERTs, not ~N inserts).
    const insertCount = prisma._executeRaw.mock.calls.filter((call: unknown[]) => {
      const s = call[0];
      const sql = Array.isArray(s) ? s.join('') : String(s);
      return /INSERT INTO .*DocumentChunk/i.test(sql);
    }).length;
    expect(insertCount).toBeGreaterThan(0);
    expect(insertCount).toBeLessThan(50); // batched, not hundreds of round-trips
  });

  it('INSERT carries the structural metadata columns (RAG-P7/Option A)', async () => {
    const prisma = makePrisma();
    const provider = makeProvider();
    const svc = build(prisma, provider, makeAudit());

    await svc.embedVersion('v-1');

    // The INSERT is a batched multi-row statement composed with Prisma.sql, so the
    // static SQL text (column list) lives in the Prisma.Sql object's `.strings`.
    const sqlTextOf = (raw: unknown): string => {
      if (Array.isArray(raw)) return raw.join('');
      const o = raw as { strings?: string[]; sql?: string };
      return o?.strings?.join(' ') ?? o?.sql ?? String(raw);
    };
    const insertCall = prisma._executeRaw.mock.calls.find((call: unknown[]) =>
      /INSERT INTO .*DocumentChunk/i.test(sqlTextOf(call[0])),
    );
    expect(insertCall).toBeDefined();
    const sql = sqlTextOf(insertCall![0]);
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
    // undefined (the DB columns are NOT NULL DEFAULT). Chunks are inserted in a
    // BATCHED multi-row INSERT built with Prisma.sql/Prisma.join: the tagged
    // template's strings are call[0]; the joined-rows Prisma.Sql (call[1]) holds
    // every interpolated param flattened in its `.values` array.
    const insertCall = prisma._executeRaw.mock.calls.find((call: unknown[]) => {
      const s = call[0];
      const sql = Array.isArray(s) ? s.join('') : String(s);
      return /INSERT INTO .*DocumentChunk/i.test(sql);
    });
    expect(insertCall).toBeDefined();
    const values = ((insertCall as unknown[])[1] as { values?: unknown[] })?.values ?? [];
    // headingPath is passed as an actual array param.
    expect(values).toContainEqual([]);
    // metadata is passed as the JSON string '{}' (cast to ::jsonb in SQL).
    expect(values).toContain('{}');
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

  describe('stale prior-version chunk cleanup', () => {
    it('deletes OTHER versions\' chunks after a full re-embed (keeps only the latest)', async () => {
      const prisma = makePrisma();
      const svc = build(prisma, makeProvider(), makeAudit());

      await expect(svc.embedVersion('v-1')).resolves.toBe('done');

      // After embedding v-1, prior versions' chunks for the same document are purged.
      expect(prisma.documentChunk.deleteMany).toHaveBeenCalledWith({
        where: { documentId: 'doc-1', versionId: { not: 'v-1' } },
      });
    });

    it('also prunes on the safe-reprocessing (no re-embed) path', async () => {
      const prisma = makePrisma();
      const provider = makeProvider();
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
      // No re-embed happened, but stale prior-version chunks are still pruned.
      expect(provider.embed).not.toHaveBeenCalled();
      expect(prisma.documentChunk.deleteMany).toHaveBeenCalledWith({
        where: { documentId: 'doc-1', versionId: { not: 'v-1' } },
      });
    });

    it('a prune failure is swallowed and never turns a successful embed into a failure', async () => {
      const prisma = makePrisma();
      prisma.documentChunk.deleteMany.mockRejectedValueOnce(new Error('db blip'));
      const svc = build(prisma, makeProvider(), makeAudit());

      // Embed still resolves 'done' despite the cleanup throwing.
      await expect(svc.embedVersion('v-1')).resolves.toBe('done');
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
