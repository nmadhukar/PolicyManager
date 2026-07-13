import { DocumentExtractionService } from './document-extraction.service';

describe('DocumentExtractionService', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const makePrisma = (): any => ({
    documentVersion: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({
        id: 'v-1',
        documentId: 'doc-1',
        s3Key: 'documents/doc-1/v1/scan.png',
        fileName: 'scan.png',
        mimeType: 'image/png',
      }),
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([{ id: 'v-1' }]),
    },
  });
  const makeS3 = () => ({ getObjectBuffer: jest.fn().mockResolvedValue(Buffer.from('bytes')) });
  const makeText = () => ({
    extractWithStatus: jest.fn().mockResolvedValue({
      text: 'ocr text',
      status: 'done',
      ocrApplied: true,
      error: null,
    }),
  });
  const makeAudit = () => ({ record: jest.fn().mockResolvedValue('ae-1') });

  it('claims a claimable version, extracts text, updates status, and audits', async () => {
    const prisma = makePrisma();
    const s3 = makeS3();
    const text = makeText();
    const audit = makeAudit();
    const svc = new DocumentExtractionService(prisma, s3 as never, text as never, audit as never);

    await expect(svc.processVersion('v-1')).resolves.toBe('done');

    // The claim is an atomic compare-and-swap over the claimable states (pending,
    // retryable failed, or stale processing) and bumps the attempt counter.
    const claim = prisma.documentVersion.updateMany.mock.calls[0][0];
    expect(claim.where.id).toBe('v-1');
    expect(claim.where.OR).toEqual(
      expect.arrayContaining([
        { extractionStatus: 'pending' },
        { extractionStatus: 'failed', extractionAttempts: { lt: expect.any(Number) } },
        { extractionStatus: 'processing', extractionStartedAt: { lt: expect.any(Date) } },
      ]),
    );
    expect(claim.data).toEqual({
      extractionStatus: 'processing',
      extractionError: null,
      extractionStartedAt: expect.any(Date),
      extractionAttempts: { increment: 1 },
    });

    expect(s3.getObjectBuffer).toHaveBeenCalledWith('documents/doc-1/v1/scan.png');
    expect(text.extractWithStatus).toHaveBeenCalledWith(expect.any(Buffer), 'image/png', 'scan.png');
    expect(prisma.documentVersion.update).toHaveBeenCalledWith({
      where: { id: 'v-1' },
      data: {
        extractedText: 'ocr text',
        hasExtractedText: true,
        extractionStatus: 'done',
        extractionError: null,
        ocrApplied: true,
        extractionStartedAt: null,
        extractionAttempts: 0,
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'extraction.processed',
        documentId: 'doc-1',
        versionId: 'v-1',
        source: 'system',
      }),
    );
  });

  it('does not process a version another worker already claimed', async () => {
    const prisma = makePrisma();
    prisma.documentVersion.updateMany.mockResolvedValue({ count: 0 });
    const s3 = makeS3();
    const text = makeText();
    const svc = new DocumentExtractionService(prisma, s3 as never, text as never, makeAudit() as never);

    await expect(svc.processVersion('v-1')).resolves.toBeNull();

    expect(s3.getObjectBuffer).not.toHaveBeenCalled();
    expect(text.extractWithStatus).not.toHaveBeenCalled();
  });

  it('marks failed WITHOUT wiping previously-extracted text on a transient error', async () => {
    const prisma = makePrisma();
    const s3 = makeS3();
    s3.getObjectBuffer.mockRejectedValue(new Error('S3 timeout'));
    const svc = new DocumentExtractionService(prisma, s3 as never, makeText() as never, makeAudit() as never);

    await expect(svc.processVersion('v-1')).resolves.toBe('failed');

    const failUpdate = prisma.documentVersion.update.mock.calls[0][0];
    expect(failUpdate.data.extractionStatus).toBe('failed');
    expect(failUpdate.data.extractionError).toContain('S3 timeout');
    expect(failUpdate.data.extractionStartedAt).toBeNull();
    // Prior text/flags are preserved (keys not present in the failure update).
    expect(failUpdate.data).not.toHaveProperty('extractedText');
    expect(failUpdate.data).not.toHaveProperty('hasExtractedText');
  });

  it('polls the claimable set (pending, retryable failed, stale processing)', async () => {
    const prisma = makePrisma();
    prisma.documentVersion.findMany.mockResolvedValue([]);
    const svc = new DocumentExtractionService(prisma, makeS3() as never, makeText() as never, makeAudit() as never);

    await svc.processPending(5);

    const where = prisma.documentVersion.findMany.mock.calls[0][0].where;
    expect(where.document).toEqual({ deletedAt: null });
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { extractionStatus: 'pending' },
        { extractionStatus: 'failed', extractionAttempts: { lt: expect.any(Number) } },
        { extractionStatus: 'processing', extractionStartedAt: { lt: expect.any(Date) } },
      ]),
    );
  });

  it('reindex re-queues only NON-done versions and resets the retry budget', async () => {
    const prisma = makePrisma();
    prisma.documentVersion.updateMany.mockResolvedValueOnce({ count: 3 }); // the reindex updateMany
    prisma.documentVersion.findMany.mockResolvedValue([]); // then processPending finds nothing
    const svc = new DocumentExtractionService(prisma, makeS3() as never, makeText() as never, makeAudit() as never);

    const result = await svc.reindexAll({ id: 'u-1' } as never, {});

    const reindexCall = prisma.documentVersion.updateMany.mock.calls[0][0];
    expect(reindexCall.where).toEqual({
      document: { deletedAt: null },
      extractionStatus: { not: 'done' },
    });
    expect(reindexCall.data).toMatchObject({
      extractionStatus: 'pending',
      extractionAttempts: 0,
      extractionStartedAt: null,
    });
    expect(result.queued).toBe(3);
  });

  it('caps concurrent eager extractions; overflow is left for the poller', () => {
    const prisma = makePrisma();
    // Hold the claim open so eagerActive never drains during the test.
    prisma.documentVersion.updateMany.mockReturnValue(new Promise(() => {}));
    const svc = new DocumentExtractionService(prisma, makeS3() as never, makeText() as never, makeAudit() as never);

    for (let i = 0; i < 6; i += 1) svc.startVersion(`v-${i}`);

    // Only MAX_EAGER_CONCURRENCY (4) reached the claim; the rest returned early.
    expect(prisma.documentVersion.updateMany).toHaveBeenCalledTimes(4);
  });
});
