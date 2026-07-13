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

  it('claims a pending version, extracts text, updates status, and audits', async () => {
    const prisma = makePrisma();
    const s3 = makeS3();
    const text = makeText();
    const audit = makeAudit();
    const svc = new DocumentExtractionService(prisma, s3 as never, text as never, audit as never);

    await expect(svc.processVersion('v-1')).resolves.toBe('done');

    expect(prisma.documentVersion.updateMany).toHaveBeenCalledWith({
      where: { id: 'v-1', extractionStatus: 'pending' },
      data: { extractionStatus: 'processing', extractionError: null },
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
});
