import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DocumentsService, type UploadedFile } from './documents.service';
import { sha256Hex } from './versioning.util';

/** Builds a mock Prisma whose $transaction supports both the array and callback forms. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makePrisma = (): any => {
  const prisma: any = {
    document: {
      findMany: jest.fn(),
      count: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    documentVersion: {
      aggregate: jest.fn(),
      create: jest.fn(),
      findFirst: jest.fn(),
    },
    documentCategory: { findUnique: jest.fn() },
    $transaction: jest.fn((arg: unknown) =>
      typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(prisma) : Promise.all(arg as unknown[]),
    ),
  };
  return prisma;
};

const makeS3 = () => ({
  buildDocumentKey: jest.fn(
    (id: string, n: number, name: string) => `documents/${id}/v${n}/${name}`,
  ),
  putObject: jest.fn().mockResolvedValue({ versionId: 's3-ver-1' }),
  getPresignedDownloadUrl: jest.fn().mockResolvedValue('https://minio.local/signed?x=1'),
});

const makeExtractor = () => ({ extract: jest.fn().mockResolvedValue('extracted words') });

const build = (p = makePrisma(), s = makeS3(), e = makeExtractor()) => ({
  prisma: p,
  s3: s,
  extractor: e,
  svc: new DocumentsService(p as never, s as never, e as never),
});

const versionRow = (over: Record<string, unknown> = {}) => ({
  id: 'v-1',
  versionNumber: 1,
  fileName: 'policy.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 10,
  checksum: 'abc',
  changeSummary: null,
  status: 'draft',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  extractedText: 'extracted words',
  uploadedBy: { name: 'Admin' },
  ...over,
});

describe('DocumentsService.addVersion', () => {
  const file: UploadedFile = {
    originalname: 'policy.pdf',
    mimetype: 'application/pdf',
    size: 12,
    buffer: Buffer.from('the-bytes'),
  };

  it('stores an immutable v1: checksum, deterministic key, S3 versionId, currentVersion set', async () => {
    const { svc, prisma, s3, extractor } = build();
    prisma.document.findUnique.mockResolvedValue({ id: 'doc-1' }); // assertDocumentExists
    prisma.documentVersion.aggregate.mockResolvedValue({ _max: { versionNumber: null } });
    prisma.documentVersion.create.mockResolvedValue(versionRow());
    prisma.document.update.mockResolvedValue({});

    const result = await svc.addVersion('doc-1', file, {}, 'user-admin');

    // Deterministic, version-scoped key.
    expect(s3.buildDocumentKey).toHaveBeenCalledWith('doc-1', 1, 'policy.pdf');
    // Bytes uploaded before the DB row.
    expect(s3.putObject).toHaveBeenCalledWith(
      'documents/doc-1/v1/policy.pdf',
      file.buffer,
      'application/pdf',
    );
    // Correct content-addressed checksum + captured S3 version id.
    const createArg = prisma.documentVersion.create.mock.calls[0][0];
    expect(createArg.data.checksum).toBe(sha256Hex(file.buffer));
    expect(createArg.data.versionNumber).toBe(1);
    expect(createArg.data.s3VersionId).toBe('s3-ver-1');
    expect(createArg.data.extractedText).toBe('extracted words');
    // Document now points at the new version.
    expect(prisma.document.update).toHaveBeenCalledWith({
      where: { id: 'doc-1' },
      data: { currentVersion: { connect: { id: 'v-1' } } },
    });
    expect(extractor.extract).toHaveBeenCalledWith(file.buffer, 'application/pdf', 'policy.pdf');
    expect(result.versionNumber).toBe(1);
    // The raw extracted text is NEVER returned — only a boolean.
    expect((result as unknown as Record<string, unknown>).extractedText).toBeUndefined();
    expect(result.hasExtractedText).toBe(true);
  });

  it('increments to the next version number from the current maximum', async () => {
    const { svc, prisma } = build();
    prisma.document.findUnique.mockResolvedValue({ id: 'doc-1' });
    prisma.documentVersion.aggregate.mockResolvedValue({ _max: { versionNumber: 4 } });
    prisma.documentVersion.create.mockResolvedValue(versionRow({ id: 'v-5', versionNumber: 5 }));
    prisma.document.update.mockResolvedValue({});

    await svc.addVersion('doc-1', file, { changeSummary: 'tweaks' }, 'user-admin');

    const createArg = prisma.documentVersion.create.mock.calls[0][0];
    expect(createArg.data.versionNumber).toBe(5);
    expect(createArg.data.changeSummary).toBe('tweaks');
  });

  it('404s when the target document does not exist (no upload attempted)', async () => {
    const { svc, prisma, s3 } = build();
    prisma.document.findUnique.mockResolvedValue(null);
    await expect(svc.addVersion('ghost', file, {}, 'u')).rejects.toBeInstanceOf(NotFoundException);
    expect(s3.putObject).not.toHaveBeenCalled();
  });

  it('omits extractedText when extraction yields nothing', async () => {
    const { svc, prisma, extractor } = build();
    prisma.document.findUnique.mockResolvedValue({ id: 'doc-1' });
    prisma.documentVersion.aggregate.mockResolvedValue({ _max: { versionNumber: null } });
    prisma.documentVersion.create.mockResolvedValue(versionRow({ extractedText: null }));
    prisma.document.update.mockResolvedValue({});
    extractor.extract.mockResolvedValue('');

    await svc.addVersion('doc-1', file, {}, 'u');
    const createArg = prisma.documentVersion.create.mock.calls[0][0];
    expect(createArg.data.extractedText).toBeUndefined();
  });
});

describe('DocumentsService.getVersionDownloadTicket', () => {
  it('presigns a short-lived URL for a version that belongs to the document', async () => {
    const { svc, prisma, s3 } = build();
    prisma.documentVersion.findFirst.mockResolvedValue({
      s3Key: 'documents/doc-1/v1/policy.pdf',
      fileName: 'policy.pdf',
    });

    const ticket = await svc.getVersionDownloadTicket('doc-1', 'v-1');

    expect(prisma.documentVersion.findFirst).toHaveBeenCalledWith({
      where: { id: 'v-1', documentId: 'doc-1' },
      select: { s3Key: true, fileName: true },
    });
    expect(s3.getPresignedDownloadUrl).toHaveBeenCalledWith(
      'documents/doc-1/v1/policy.pdf',
      300,
      'policy.pdf',
    );
    expect(ticket).toEqual({
      url: 'https://minio.local/signed?x=1',
      expiresIn: 300,
      fileName: 'policy.pdf',
    });
  });

  it('404s (no presign) when the version is not under that document', async () => {
    const { svc, prisma, s3 } = build();
    prisma.documentVersion.findFirst.mockResolvedValue(null);
    await expect(svc.getVersionDownloadTicket('doc-1', 'other')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(s3.getPresignedDownloadUrl).not.toHaveBeenCalled();
  });
});

const fullDocRow = (over: Record<string, unknown> = {}) => ({
  id: 'doc-1',
  title: 'Policy',
  documentNumber: 'PP-1',
  categoryId: 'cat-1',
  ownerId: 'owner-1',
  description: 'desc',
  status: 'draft',
  accessLevel: 'restricted',
  tags: ['CARF'],
  reviewCadence: 'annual',
  nextReviewDate: new Date('2026-09-01T00:00:00Z'),
  effectiveDate: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-02-01T00:00:00Z'),
  category: { name: 'Policies' },
  owner: { name: 'Owner' },
  currentVersion: versionRow(),
  versions: [versionRow()],
  ...over,
});

describe('DocumentsService.list', () => {
  it('returns a mapped, paginated envelope with category/owner/current-version summaries', async () => {
    const { svc, prisma } = build();
    prisma.document.findMany.mockResolvedValue([fullDocRow()]);
    prisma.document.count.mockResolvedValue(1);

    const result = await svc.list({ page: 1, pageSize: 20, sort: 'title', order: 'asc' });

    expect(result).toMatchObject({ total: 1, page: 1, pageSize: 20 });
    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item.categoryName).toBe('Policies');
    expect(item.ownerName).toBe('Owner');
    expect(item.currentVersion?.versionNumber).toBe(1);
    // Dates are serialized to ISO strings for the wire contract.
    expect(item.nextReviewDate).toBe('2026-09-01T00:00:00.000Z');
    // findMany received the built pagination args.
    const findArg = prisma.document.findMany.mock.calls[0][0];
    expect(findArg.take).toBe(20);
    expect(findArg.orderBy).toEqual({ title: 'asc' });
  });
});

describe('DocumentsService.update', () => {
  it('builds a partial patch: disconnects category on null and clears a date', async () => {
    const { svc, prisma } = build();
    prisma.document.findUnique
      .mockResolvedValueOnce({ id: 'doc-1' }) // assertDocumentExists
      .mockResolvedValueOnce(fullDocRow()); // get() reload
    prisma.document.update.mockResolvedValue({});

    await svc.update('doc-1', {
      title: 'New Title',
      status: 'published',
      tags: ['A', 'B'],
      categoryId: null,
      nextReviewDate: null,
    });

    const data = prisma.document.update.mock.calls[0][0].data;
    expect(data.title).toBe('New Title');
    expect(data.status).toBe('published');
    expect(data.tags).toEqual(['A', 'B']);
    expect(data.category).toEqual({ disconnect: true });
    expect(data.nextReviewDate).toBeNull();
  });

  it('connects a category and parses a provided review date', async () => {
    const { svc, prisma } = build();
    prisma.documentCategory.findUnique.mockResolvedValue({ id: 'cat-9' });
    prisma.document.findUnique
      .mockResolvedValueOnce({ id: 'doc-1' })
      .mockResolvedValueOnce(fullDocRow());
    prisma.document.update.mockResolvedValue({});

    await svc.update('doc-1', { categoryId: 'cat-9', nextReviewDate: '2026-12-31' });

    const data = prisma.document.update.mock.calls[0][0].data;
    expect(data.category).toEqual({ connect: { id: 'cat-9' } });
    expect(data.nextReviewDate).toBeInstanceOf(Date);
  });

  it('404s for an unknown document', async () => {
    const { svc, prisma } = build();
    prisma.document.findUnique.mockResolvedValue(null);
    await expect(svc.update('ghost', { title: 'x' })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('DocumentsService.create', () => {
  it('rejects an unknown categoryId with 400 before writing', async () => {
    const { svc, prisma } = build();
    prisma.documentCategory.findUnique.mockResolvedValue(null);
    await expect(
      svc.create({ title: 'X', categoryId: 'nope' } as never, 'owner-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.document.create).not.toHaveBeenCalled();
  });

  it('defaults tags to [] and stamps the owner from the caller', async () => {
    const { svc, prisma } = build();
    prisma.document.create.mockResolvedValue({ id: 'doc-new' });
    // get() reload after create:
    prisma.document.findUnique.mockResolvedValue({
      id: 'doc-new',
      title: 'X',
      documentNumber: null,
      categoryId: null,
      ownerId: 'owner-1',
      description: null,
      status: 'draft',
      accessLevel: 'restricted',
      tags: [],
      reviewCadence: 'none',
      nextReviewDate: null,
      effectiveDate: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      category: null,
      owner: { name: 'Owner' },
      currentVersion: null,
      versions: [],
    });

    const detail = await svc.create({ title: 'X' } as never, 'owner-1');

    const createArg = prisma.document.create.mock.calls[0][0];
    expect(createArg.data.ownerId).toBe('owner-1');
    expect(createArg.data.tags).toEqual([]);
    expect(detail.id).toBe('doc-new');
    expect(detail.versions).toEqual([]);
  });
});
