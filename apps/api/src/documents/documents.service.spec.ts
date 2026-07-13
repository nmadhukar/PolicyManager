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
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    documentVersion: {
      aggregate: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
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
  buildRenditionKey: jest.fn((id: string, n: number) => `renditions/${id}/v${n}/rendition.pdf`),
  putObject: jest.fn().mockResolvedValue({ versionId: 's3-ver-1' }),
  copyObject: jest.fn().mockResolvedValue({ versionId: 's3-copy-ver' }),
  getObjectBuffer: jest.fn().mockResolvedValue(Buffer.from('bytes')),
  getPresignedDownloadUrl: jest.fn().mockResolvedValue('https://minio.local/signed?x=1'),
});

const makeExtractor = () => ({ extract: jest.fn().mockResolvedValue('extracted words') });

// Rendition generation is best-effort and independently unit-tested; here it is a
// no-op stub returning "no rendition" so version-write assertions stay focused.
const makeRenditions = () => ({
  generateForVersion: jest
    .fn()
    .mockResolvedValue({ renditionS3Key: null, strategy: 'passthrough' }),
});

const makeOnlyOffice = () => ({
  buildEditorConfig: jest.fn().mockReturnValue({ token: 'signed' }),
  downloadEditedFile: jest.fn().mockResolvedValue(Buffer.from('edited-bytes')),
});

const build = (
  p = makePrisma(),
  s = makeS3(),
  e = makeExtractor(),
  r = makeRenditions(),
  o = makeOnlyOffice(),
) => ({
  prisma: p,
  s3: s,
  extractor: e,
  renditions: r,
  onlyOffice: o,
  svc: new DocumentsService(p as never, s as never, e as never, r as never, o as never),
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
  renditionS3Key: null,
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
    prisma.document.findFirst.mockResolvedValue({ id: 'doc-1' }); // assertDocumentExists
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
    prisma.document.findFirst.mockResolvedValue({ id: 'doc-1' });
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
    prisma.document.findFirst.mockResolvedValue(null);
    await expect(svc.addVersion('ghost', file, {}, 'u')).rejects.toBeInstanceOf(NotFoundException);
    expect(s3.putObject).not.toHaveBeenCalled();
  });

  it('omits extractedText when extraction yields nothing', async () => {
    const { svc, prisma, extractor } = build();
    prisma.document.findFirst.mockResolvedValue({ id: 'doc-1' });
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
      // A version of a soft-deleted document must not be downloadable.
      where: { id: 'v-1', documentId: 'doc-1', document: { deletedAt: null } },
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

describe('DocumentsService.getVersionViewTicket', () => {
  it('serves the PDF rendition when present (inline, short-lived)', async () => {
    const { svc, prisma, s3 } = build();
    prisma.documentVersion.findFirst.mockResolvedValue({
      s3Key: 'documents/doc-1/v1/policy.docx',
      renditionS3Key: 'renditions/doc-1/v1/rendition.pdf',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    const ticket = await svc.getVersionViewTicket('doc-1', 'v-1');

    // Scoped to a non-deleted document.
    expect(prisma.documentVersion.findFirst.mock.calls[0][0].where).toEqual({
      id: 'v-1',
      documentId: 'doc-1',
      document: { deletedAt: null },
    });
    // Presigns the rendition key WITHOUT an attachment disposition (inline view).
    expect(s3.getPresignedDownloadUrl).toHaveBeenCalledWith(
      'renditions/doc-1/v1/rendition.pdf',
      300,
    );
    expect(ticket).toEqual({
      url: 'https://minio.local/signed?x=1',
      expiresIn: 300,
      mimeType: 'application/pdf',
    });
  });

  it('serves a source PDF directly when it needs no rendition', async () => {
    const { svc, prisma, s3 } = build();
    prisma.documentVersion.findFirst.mockResolvedValue({
      s3Key: 'documents/doc-1/v1/policy.pdf',
      renditionS3Key: null,
      mimeType: 'application/pdf',
    });
    const ticket = await svc.getVersionViewTicket('doc-1', 'v-1');
    expect(s3.getPresignedDownloadUrl).toHaveBeenCalledWith('documents/doc-1/v1/policy.pdf', 300);
    expect(ticket.mimeType).toBe('application/pdf');
  });

  it('serves a source image with its own mime type', async () => {
    const { svc, prisma } = build();
    prisma.documentVersion.findFirst.mockResolvedValue({
      s3Key: 'documents/doc-1/v1/scan.png',
      renditionS3Key: null,
      mimeType: 'image/png',
    });
    const ticket = await svc.getVersionViewTicket('doc-1', 'v-1');
    expect(ticket.mimeType).toBe('image/png');
  });

  it('404s an office source that has no rendition yet (not viewable)', async () => {
    const { svc, prisma } = build();
    prisma.documentVersion.findFirst.mockResolvedValue({
      s3Key: 'documents/doc-1/v1/policy.docx',
      renditionS3Key: null,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    await expect(svc.getVersionViewTicket('doc-1', 'v-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('404s when the version is not under the (non-deleted) document', async () => {
    const { svc, prisma, s3 } = build();
    prisma.documentVersion.findFirst.mockResolvedValue(null);
    await expect(svc.getVersionViewTicket('doc-1', 'ghost')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(s3.getPresignedDownloadUrl).not.toHaveBeenCalled();
  });
});

describe('DocumentsService.getEditorConfig', () => {
  it('builds a signed config for an editable current version', async () => {
    const { svc, prisma, onlyOffice } = build();
    prisma.document.findFirst.mockResolvedValue({
      currentVersion: { id: 'v-1', fileName: 'policy.docx' },
    });
    const cfg = await svc.getEditorConfig('doc-1', { id: 'u-1', name: 'Dr Smith' });
    expect(onlyOffice.buildEditorConfig).toHaveBeenCalledWith({
      documentId: 'doc-1',
      versionId: 'v-1',
      fileName: 'policy.docx',
      documentType: 'word',
      user: { id: 'u-1', name: 'Dr Smith' },
    });
    expect(cfg).toEqual({ token: 'signed' });
  });

  it('400s when the current version is not an editable Office type', async () => {
    const { svc, prisma, onlyOffice } = build();
    prisma.document.findFirst.mockResolvedValue({
      currentVersion: { id: 'v-1', fileName: 'policy.pdf' },
    });
    await expect(svc.getEditorConfig('doc-1', { id: 'u', name: 'n' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(onlyOffice.buildEditorConfig).not.toHaveBeenCalled();
  });

  it('400s when the document has no version to edit', async () => {
    const { svc, prisma } = build();
    prisma.document.findFirst.mockResolvedValue({ currentVersion: null });
    await expect(svc.getEditorConfig('doc-1', { id: 'u', name: 'n' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('404s for a missing/soft-deleted document', async () => {
    const { svc, prisma } = build();
    prisma.document.findFirst.mockResolvedValue(null);
    await expect(svc.getEditorConfig('gone', { id: 'u', name: 'n' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('DocumentsService.applyEditorCallback (save => new version)', () => {
  it('acks non-save statuses WITHOUT creating a version', async () => {
    const { svc, prisma, onlyOffice } = build();
    for (const status of [1, 3, 4, 7]) {
      const res = await svc.applyEditorCallback('doc-1', 'v-1', { status }, 'u-ed');
      expect(res).toEqual({ error: 0 });
    }
    expect(onlyOffice.downloadEditedFile).not.toHaveBeenCalled();
    expect(prisma.documentVersion.create).not.toHaveBeenCalled();
  });

  it('on status 2 downloads the edited bytes and writes a NEW immutable version', async () => {
    const { svc, prisma, s3, onlyOffice } = build();
    // source version lookup (name/mime + owner fallback)
    prisma.documentVersion.findFirst.mockResolvedValue({
      fileName: 'policy.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      document: { ownerId: 'owner-1' },
    });
    // writeVersion path:
    prisma.documentVersion.aggregate.mockResolvedValue({ _max: { versionNumber: 2 } });
    prisma.documentVersion.create.mockResolvedValue(
      versionRow({ id: 'v-3', versionNumber: 3, fileName: 'policy.docx' }),
    );
    prisma.document.update.mockResolvedValue({});

    const res = await svc.applyEditorCallback(
      'doc-1',
      'v-1',
      { status: 2, url: 'http://docs/cache/out.docx' },
      'u-editor',
    );

    expect(onlyOffice.downloadEditedFile).toHaveBeenCalledWith('http://docs/cache/out.docx');
    // A NEW version object is written (v3), attributed to the editor.
    const createArg = prisma.documentVersion.create.mock.calls[0][0];
    expect(createArg.data.versionNumber).toBe(3);
    expect(createArg.data.changeSummary).toBe('Edited in OnlyOffice');
    expect(createArg.data.uploadedById).toBe('u-editor');
    expect(s3.putObject).toHaveBeenCalled(); // edited bytes stored at a fresh key
    // Document advanced to the new current version.
    expect(prisma.document.update).toHaveBeenCalledWith({
      where: { id: 'doc-1' },
      data: { currentVersion: { connect: { id: 'v-3' } } },
    });
    expect(res).toEqual({ error: 0 });
  });

  it('falls back to the document owner when the token carries no editor id', async () => {
    const { svc, prisma } = build();
    prisma.documentVersion.findFirst.mockResolvedValue({
      fileName: 'policy.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      document: { ownerId: 'owner-1' },
    });
    prisma.documentVersion.aggregate.mockResolvedValue({ _max: { versionNumber: 1 } });
    prisma.documentVersion.create.mockResolvedValue(versionRow({ id: 'v-2', versionNumber: 2 }));
    prisma.document.update.mockResolvedValue({});

    await svc.applyEditorCallback('doc-1', 'v-1', { status: 2, url: 'http://x' }, undefined);

    expect(prisma.documentVersion.create.mock.calls[0][0].data.uploadedById).toBe('owner-1');
  });

  it('400s a save callback that is missing the document url', async () => {
    const { svc } = build();
    await expect(
      svc.applyEditorCallback('doc-1', 'v-1', { status: 2 }, 'u'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('DocumentsService.getVersionSource (OnlyOffice content route)', () => {
  it('returns the source bytes for a version scoped to a non-deleted document', async () => {
    const { svc, prisma, s3 } = build();
    prisma.documentVersion.findFirst.mockResolvedValue({
      s3Key: 'documents/doc-1/v1/policy.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      fileName: 'policy.docx',
    });
    s3.getObjectBuffer.mockResolvedValue(Buffer.from('docx-bytes'));

    const result = await svc.getVersionSource('doc-1', 'v-1');

    // Scoped so a version of a trashed document can't be streamed to the editor.
    expect(prisma.documentVersion.findFirst.mock.calls[0][0].where).toEqual({
      id: 'v-1',
      documentId: 'doc-1',
      document: { deletedAt: null },
    });
    expect(s3.getObjectBuffer).toHaveBeenCalledWith('documents/doc-1/v1/policy.docx');
    expect(result.fileName).toBe('policy.docx');
    expect(result.buffer.toString()).toBe('docx-bytes');
  });

  it('404s (no S3 fetch) when the version is not under the document', async () => {
    const { svc, prisma, s3 } = build();
    prisma.documentVersion.findFirst.mockResolvedValue(null);
    await expect(svc.getVersionSource('doc-1', 'ghost')).rejects.toBeInstanceOf(NotFoundException);
    expect(s3.getObjectBuffer).not.toHaveBeenCalled();
  });
});

describe('DocumentsService.getVersionHtml (TipTap load)', () => {
  it('returns the HTML for a text/html version', async () => {
    const { svc, prisma, s3 } = build();
    prisma.documentVersion.findFirst.mockResolvedValue({
      s3Key: 'documents/doc-1/v1/document.html',
      mimeType: 'text/html',
    });
    s3.getObjectBuffer.mockResolvedValue(Buffer.from('<h1>Hi</h1>'));
    const result = await svc.getVersionHtml('doc-1', 'v-1');
    expect(result).toEqual({ html: '<h1>Hi</h1>' });
  });

  it('400s a non-HTML version (not editable as text)', async () => {
    const { svc, prisma, s3 } = build();
    prisma.documentVersion.findFirst.mockResolvedValue({
      s3Key: 'documents/doc-1/v1/policy.pdf',
      mimeType: 'application/pdf',
    });
    await expect(svc.getVersionHtml('doc-1', 'v-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(s3.getObjectBuffer).not.toHaveBeenCalled();
  });

  it('404s when the version is not under the (non-deleted) document', async () => {
    const { svc, prisma } = build();
    prisma.documentVersion.findFirst.mockResolvedValue(null);
    await expect(svc.getVersionHtml('doc-1', 'ghost')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('DocumentsService.regenerateRendition', () => {
  it('regenerates + persists the new rendition key on the version', async () => {
    const { svc, prisma, renditions } = build();
    prisma.documentVersion.findFirst.mockResolvedValue({
      versionNumber: 2,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      fileName: 'policy.docx',
      s3Key: 'documents/doc-1/v2/policy.docx',
    });
    renditions.generateForVersion.mockResolvedValue({
      renditionS3Key: 'renditions/doc-1/v2/rendition.pdf',
      strategy: 'office',
    });
    prisma.documentVersion.update.mockResolvedValue(
      versionRow({ id: 'v-2', versionNumber: 2, renditionS3Key: 'renditions/doc-1/v2/rendition.pdf' }),
    );

    const result = await svc.regenerateRendition('doc-1', 'v-2');

    expect(renditions.generateForVersion).toHaveBeenCalledWith({
      documentId: 'doc-1',
      versionNumber: 2,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      fileName: 'policy.docx',
      sourceS3Key: 'documents/doc-1/v2/policy.docx',
    });
    expect(prisma.documentVersion.update.mock.calls[0][0].data).toEqual({
      renditionS3Key: 'renditions/doc-1/v2/rendition.pdf',
    });
    expect(result.hasRendition).toBe(true);
  });

  it('404s for a version not under the (non-deleted) document', async () => {
    const { svc, prisma, renditions } = build();
    prisma.documentVersion.findFirst.mockResolvedValue(null);
    await expect(svc.regenerateRendition('doc-1', 'ghost')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(renditions.generateForVersion).not.toHaveBeenCalled();
  });
});

describe('DocumentsService.addHtmlVersion (TipTap save)', () => {
  it('writes an HTML version (text/html) via the shared version-write path', async () => {
    const { svc, prisma, s3 } = build();
    prisma.document.findFirst.mockResolvedValue({ id: 'doc-1' }); // assertDocumentExists
    prisma.documentVersion.aggregate.mockResolvedValue({ _max: { versionNumber: null } });
    prisma.documentVersion.create.mockResolvedValue(
      versionRow({ id: 'v-1', fileName: 'document.html', mimeType: 'text/html' }),
    );
    prisma.document.update.mockResolvedValue({});

    await svc.addHtmlVersion('doc-1', '<h1>Hello</h1>', 'First draft', 'u-1');

    // Stored as text/html with the html bytes.
    const putArgs = s3.putObject.mock.calls[0];
    expect(putArgs[2]).toBe('text/html');
    expect(putArgs[1].toString()).toBe('<h1>Hello</h1>');
    const createArg = prisma.documentVersion.create.mock.calls[0][0];
    expect(createArg.data.mimeType).toBe('text/html');
    expect(createArg.data.fileName).toBe('document.html');
    expect(createArg.data.changeSummary).toBe('First draft');
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
  deletedAt: null,
  deletedBy: null,
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
    prisma.document.findFirst
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
    prisma.document.findFirst
      .mockResolvedValueOnce({ id: 'doc-1' })
      .mockResolvedValueOnce(fullDocRow());
    prisma.document.update.mockResolvedValue({});

    await svc.update('doc-1', { categoryId: 'cat-9', nextReviewDate: '2026-12-31' });

    const data = prisma.document.update.mock.calls[0][0].data;
    expect(data.category).toEqual({ connect: { id: 'cat-9' } });
    expect(data.nextReviewDate).toBeInstanceOf(Date);
  });

  it('404s for an unknown (or soft-deleted) document', async () => {
    const { svc, prisma } = build();
    prisma.document.findFirst.mockResolvedValue(null);
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
    prisma.document.findFirst.mockResolvedValue({
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

describe('DocumentsService.get (soft-delete aware)', () => {
  it('loads a document scoped to non-deleted rows and maps deletedAt', async () => {
    const { svc, prisma } = build();
    prisma.document.findFirst.mockResolvedValue(fullDocRow());

    const detail = await svc.get('doc-1');

    // get() must never surface a soft-deleted document.
    const arg = prisma.document.findFirst.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 'doc-1', deletedAt: null });
    expect(detail.deletedAt).toBeNull();
    expect(detail.deletedByName).toBeNull();
  });

  it('404s when the document is missing or soft-deleted', async () => {
    const { svc, prisma } = build();
    prisma.document.findFirst.mockResolvedValue(null);
    await expect(svc.get('gone')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('DocumentsService.softDelete', () => {
  it('stamps deletedAt + deletedBy without removing rows or bytes', async () => {
    const { svc, prisma } = build();
    prisma.document.findFirst
      .mockResolvedValueOnce({ id: 'doc-1', deletedAt: null }) // active guard
      .mockResolvedValueOnce(fullDocRow({ deletedAt: new Date('2026-03-01T00:00:00Z'), deletedBy: { name: 'Admin' } })); // reload incl. deleted
    prisma.document.update.mockResolvedValue({});

    const detail = await svc.softDelete('doc-1', 'user-admin');

    const updateArg = prisma.document.update.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: 'doc-1' });
    expect(updateArg.data.deletedAt).toBeInstanceOf(Date);
    expect(updateArg.data.deletedBy).toEqual({ connect: { id: 'user-admin' } });
    // No hard-delete anywhere.
    expect(prisma.document.delete).toBeUndefined();
    expect(detail.deletedAt).toBe('2026-03-01T00:00:00.000Z');
    expect(detail.deletedByName).toBe('Admin');
  });

  it('404s (and does not write) when the document is already deleted/missing', async () => {
    const { svc, prisma } = build();
    prisma.document.findFirst.mockResolvedValue(null);
    await expect(svc.softDelete('gone', 'u')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.document.update).not.toHaveBeenCalled();
  });
});

describe('DocumentsService.restore', () => {
  it('clears deletedAt/deletedById for a trashed document', async () => {
    const { svc, prisma } = build();
    prisma.document.findFirst
      .mockResolvedValueOnce({ id: 'doc-1' }) // trashed guard
      .mockResolvedValueOnce(fullDocRow()); // reload
    prisma.document.update.mockResolvedValue({});

    await svc.restore('doc-1');

    // Guard queried the trash (deletedAt not null).
    expect(prisma.document.findFirst.mock.calls[0][0].where).toEqual({
      id: 'doc-1',
      deletedAt: { not: null },
    });
    const updateArg = prisma.document.update.mock.calls[0][0];
    expect(updateArg.data).toEqual({ deletedAt: null, deletedById: null });
  });

  it('404s when the document is not in the trash', async () => {
    const { svc, prisma } = build();
    prisma.document.findFirst.mockResolvedValue(null);
    await expect(svc.restore('doc-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.document.update).not.toHaveBeenCalled();
  });
});

describe('DocumentsService.archive / unarchive', () => {
  it('archives a published document and stashes the prior status', async () => {
    const { svc, prisma } = build();
    prisma.document.findFirst
      .mockResolvedValueOnce({ id: 'doc-1', status: 'published' }) // guard
      .mockResolvedValueOnce(fullDocRow({ status: 'archived' })); // reload
    prisma.document.update.mockResolvedValue({});

    await svc.archive('doc-1');

    const data = prisma.document.update.mock.calls[0][0].data;
    expect(data.status).toBe('archived');
    expect(data.preArchiveStatus).toBe('published');
  });

  it('archive is a no-op when already archived (no double-stash)', async () => {
    const { svc, prisma } = build();
    prisma.document.findFirst
      .mockResolvedValueOnce({ id: 'doc-1', status: 'archived' }) // guard
      .mockResolvedValueOnce(fullDocRow({ status: 'archived' })); // reload
    await svc.archive('doc-1');
    expect(prisma.document.update).not.toHaveBeenCalled();
  });

  it('unarchive restores the stashed prior status and clears it', async () => {
    const { svc, prisma } = build();
    prisma.document.findFirst
      .mockResolvedValueOnce({ id: 'doc-1', status: 'archived', preArchiveStatus: 'published' })
      .mockResolvedValueOnce(fullDocRow({ status: 'published' }));
    prisma.document.update.mockResolvedValue({});

    await svc.unarchive('doc-1');

    const data = prisma.document.update.mock.calls[0][0].data;
    expect(data.status).toBe('published');
    expect(data.preArchiveStatus).toBeNull();
  });

  it('unarchive falls back to draft when no prior status was stashed', async () => {
    const { svc, prisma } = build();
    prisma.document.findFirst
      .mockResolvedValueOnce({ id: 'doc-1', status: 'archived', preArchiveStatus: null })
      .mockResolvedValueOnce(fullDocRow({ status: 'draft' }));
    prisma.document.update.mockResolvedValue({});

    await svc.unarchive('doc-1');

    expect(prisma.document.update.mock.calls[0][0].data.status).toBe('draft');
  });

  it('archive 404s for a missing/soft-deleted document', async () => {
    const { svc, prisma } = build();
    prisma.document.findFirst.mockResolvedValue(null);
    await expect(svc.archive('gone')).rejects.toBeInstanceOf(NotFoundException);
    // Archive must only ever act on active (non-deleted) documents.
    expect(prisma.document.findFirst.mock.calls[0][0].where).toEqual({
      id: 'gone',
      deletedAt: null,
    });
  });
});

describe('DocumentsService.restoreVersion', () => {
  const sourceVersion = {
    versionNumber: 1,
    s3Key: 'documents/doc-1/v1/policy.pdf',
    fileName: 'policy.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 10,
    checksum: 'sha-of-v1',
    extractedText: 'v1 words',
  };

  it('copies the old object to a NEW key and appends a new current version (history preserved)', async () => {
    const { svc, prisma, s3 } = build();
    prisma.document.findFirst.mockResolvedValue({ id: 'doc-1' }); // active doc guard
    prisma.documentVersion.findFirst.mockResolvedValue(sourceVersion);
    prisma.documentVersion.aggregate.mockResolvedValue({ _max: { versionNumber: 2 } });
    prisma.documentVersion.create.mockResolvedValue(
      versionRow({ id: 'v-3', versionNumber: 3, changeSummary: 'Restored from v1' }),
    );
    prisma.document.update.mockResolvedValue({});

    const result = await svc.restoreVersion('doc-1', 'v-1', 'user-admin');

    // New, version-scoped destination key — never the source key.
    expect(s3.buildDocumentKey).toHaveBeenCalledWith('doc-1', 3, 'policy.pdf');
    expect(s3.copyObject).toHaveBeenCalledWith(
      'documents/doc-1/v1/policy.pdf',
      'documents/doc-1/v3/policy.pdf',
      'application/pdf',
    );
    // The old object is copied, never moved/deleted.
    expect(s3.putObject).not.toHaveBeenCalled();

    const createArg = prisma.documentVersion.create.mock.calls[0][0];
    expect(createArg.data.versionNumber).toBe(3);
    expect(createArg.data.s3Key).toBe('documents/doc-1/v3/policy.pdf');
    expect(createArg.data.s3VersionId).toBe('s3-copy-ver');
    // Identical bytes ⇒ identical checksum is carried forward.
    expect(createArg.data.checksum).toBe('sha-of-v1');
    expect(createArg.data.changeSummary).toBe('Restored from v1');
    expect(createArg.data.uploadedById).toBe('user-admin');
    // Document now points at the newly created version.
    expect(prisma.document.update).toHaveBeenCalledWith({
      where: { id: 'doc-1' },
      data: { currentVersion: { connect: { id: 'v-3' } } },
    });
    expect(result.versionNumber).toBe(3);
  });

  it('404s when the source version is not under the document (nothing copied)', async () => {
    const { svc, prisma, s3 } = build();
    prisma.document.findFirst.mockResolvedValue({ id: 'doc-1' });
    prisma.documentVersion.findFirst.mockResolvedValue(null);
    await expect(svc.restoreVersion('doc-1', 'ghost', 'u')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(s3.copyObject).not.toHaveBeenCalled();
    expect(prisma.documentVersion.create).not.toHaveBeenCalled();
  });

  it('404s when the parent document is missing/soft-deleted (nothing copied)', async () => {
    const { svc, prisma, s3 } = build();
    prisma.document.findFirst.mockResolvedValue(null);
    await expect(svc.restoreVersion('gone', 'v-1', 'u')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.documentVersion.findFirst).not.toHaveBeenCalled();
    expect(s3.copyObject).not.toHaveBeenCalled();
  });
});
