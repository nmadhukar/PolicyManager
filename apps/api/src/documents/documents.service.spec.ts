import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '@policymanager/shared';
import type { RequestContext } from '../audit/request-context';
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

// Access is allowed by default; individual tests flip canAccess to false to prove
// enforcement. buildListWhere defaults to {} (an admin-style all-access clause).
const makeAccess = () => ({
  canAccess: jest.fn().mockResolvedValue(true),
  buildListWhere: jest.fn().mockResolvedValue({}),
});

const makeAudit = () => ({ record: jest.fn().mockResolvedValue('ae-1') });

const build = (
  p = makePrisma(),
  s = makeS3(),
  e = makeExtractor(),
  r = makeRenditions(),
  o = makeOnlyOffice(),
  ac = makeAccess(),
  au = makeAudit(),
) => ({
  prisma: p,
  s3: s,
  extractor: e,
  renditions: r,
  onlyOffice: o,
  access: ac,
  audit: au,
  svc: new DocumentsService(
    p as never,
    s as never,
    e as never,
    r as never,
    o as never,
    ac as never,
    au as never,
  ),
});

/** The acting user + request context threaded through every route. */
const actor: AuthUser = {
  id: 'user-admin',
  email: 'admin@x.com',
  name: 'Admin',
  roles: ['Admin'],
  permissions: ['document.read', 'document.write', 'document.approve'],
  mustChangePassword: false,
};
const reqCtx: RequestContext = { ipAddress: '127.0.0.1', userAgent: 'jest' };

/** Access-relevant doc row returned by the access-scoped lookups. */
const accessDoc = (over: Record<string, unknown> = {}) => ({
  id: 'doc-1',
  ownerId: 'owner-1',
  accessLevel: 'restricted',
  categoryId: null,
  ...over,
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

  it('stores an immutable v1 and audits version.uploaded', async () => {
    const { svc, prisma, s3, extractor, audit } = build();
    prisma.document.findFirst.mockResolvedValue(accessDoc()); // loadAccessDoc
    prisma.documentVersion.aggregate.mockResolvedValue({ _max: { versionNumber: null } });
    prisma.documentVersion.create.mockResolvedValue(versionRow());
    prisma.document.update.mockResolvedValue({});

    const result = await svc.addVersion('doc-1', file, {}, actor, reqCtx);

    expect(s3.buildDocumentKey).toHaveBeenCalledWith('doc-1', 1, 'policy.pdf');
    expect(s3.putObject).toHaveBeenCalledWith(
      'documents/doc-1/v1/policy.pdf',
      file.buffer,
      'application/pdf',
    );
    const createArg = prisma.documentVersion.create.mock.calls[0][0];
    expect(createArg.data.checksum).toBe(sha256Hex(file.buffer));
    expect(createArg.data.versionNumber).toBe(1);
    expect(createArg.data.s3VersionId).toBe('s3-ver-1');
    expect(createArg.data.extractedText).toBe('extracted words');
    expect(prisma.document.update).toHaveBeenCalledWith({
      where: { id: 'doc-1' },
      data: { currentVersion: { connect: { id: 'v-1' } } },
    });
    expect(extractor.extract).toHaveBeenCalledWith(file.buffer, 'application/pdf', 'policy.pdf');
    expect(result.versionNumber).toBe(1);
    expect((result as unknown as Record<string, unknown>).extractedText).toBeUndefined();
    expect(result.hasExtractedText).toBe(true);
    // Audit: the upload is recorded with the version id + request context.
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'version.uploaded',
        actorUserId: 'user-admin',
        documentId: 'doc-1',
        versionId: 'v-1',
        ipAddress: '127.0.0.1',
      }),
    );
  });

  it('403s + audits access.denied when the caller cannot edit (no version written)', async () => {
    const { svc, prisma, s3, access, audit } = build();
    prisma.document.findFirst.mockResolvedValue(accessDoc({ accessLevel: 'confidential' }));
    access.canAccess.mockResolvedValue(false);

    await expect(svc.addVersion('doc-1', file, {}, actor, reqCtx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(s3.putObject).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'access.denied', documentId: 'doc-1' }),
    );
  });

  it('increments to the next version number from the current maximum', async () => {
    const { svc, prisma } = build();
    prisma.document.findFirst.mockResolvedValue(accessDoc());
    prisma.documentVersion.aggregate.mockResolvedValue({ _max: { versionNumber: 4 } });
    prisma.documentVersion.create.mockResolvedValue(versionRow({ id: 'v-5', versionNumber: 5 }));
    prisma.document.update.mockResolvedValue({});

    await svc.addVersion('doc-1', file, { changeSummary: 'tweaks' }, actor, reqCtx);

    const createArg = prisma.documentVersion.create.mock.calls[0][0];
    expect(createArg.data.versionNumber).toBe(5);
    expect(createArg.data.changeSummary).toBe('tweaks');
  });

  it('404s when the target document does not exist (no upload attempted)', async () => {
    const { svc, prisma, s3 } = build();
    prisma.document.findFirst.mockResolvedValue(null);
    await expect(svc.addVersion('ghost', file, {}, actor, reqCtx)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(s3.putObject).not.toHaveBeenCalled();
  });

  it('omits extractedText when extraction yields nothing', async () => {
    const { svc, prisma, extractor } = build();
    prisma.document.findFirst.mockResolvedValue(accessDoc());
    prisma.documentVersion.aggregate.mockResolvedValue({ _max: { versionNumber: null } });
    prisma.documentVersion.create.mockResolvedValue(versionRow({ extractedText: null }));
    prisma.document.update.mockResolvedValue({});
    extractor.extract.mockResolvedValue('');

    await svc.addVersion('doc-1', file, {}, actor, reqCtx);
    const createArg = prisma.documentVersion.create.mock.calls[0][0];
    expect(createArg.data.extractedText).toBeUndefined();
  });
});

describe('DocumentsService.getVersionDownloadTicket', () => {
  it('enforces download, presigns a short-lived URL, and audits document.downloaded', async () => {
    const { svc, prisma, s3, access, audit } = build();
    prisma.documentVersion.findFirst.mockResolvedValue({
      s3Key: 'documents/doc-1/v1/policy.pdf',
      fileName: 'policy.pdf',
      document: accessDoc(),
    });

    const ticket = await svc.getVersionDownloadTicket('doc-1', 'v-1', actor, reqCtx);

    expect(prisma.documentVersion.findFirst.mock.calls[0][0].where).toEqual({
      id: 'v-1',
      documentId: 'doc-1',
      document: { deletedAt: null },
    });
    expect(access.canAccess).toHaveBeenCalledWith(actor, accessDoc(), 'download');
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
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'document.downloaded', versionId: 'v-1' }),
    );
  });

  it('403s + audits access.denied when the caller cannot download (no presign)', async () => {
    const { svc, prisma, s3, access, audit } = build();
    prisma.documentVersion.findFirst.mockResolvedValue({
      s3Key: 'k',
      fileName: 'policy.pdf',
      document: accessDoc({ accessLevel: 'confidential' }),
    });
    access.canAccess.mockResolvedValue(false);

    await expect(
      svc.getVersionDownloadTicket('doc-1', 'v-1', actor, reqCtx),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(s3.getPresignedDownloadUrl).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'access.denied', versionId: 'v-1' }),
    );
  });

  it('404s (no presign) when the version is not under that document', async () => {
    const { svc, prisma, s3 } = build();
    prisma.documentVersion.findFirst.mockResolvedValue(null);
    await expect(
      svc.getVersionDownloadTicket('doc-1', 'other', actor, reqCtx),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(s3.getPresignedDownloadUrl).not.toHaveBeenCalled();
  });
});

describe('DocumentsService.getVersionViewTicket', () => {
  it('serves the PDF rendition when present and audits document.viewed', async () => {
    const { svc, prisma, s3, audit } = build();
    prisma.documentVersion.findFirst.mockResolvedValue({
      s3Key: 'documents/doc-1/v1/policy.docx',
      renditionS3Key: 'renditions/doc-1/v1/rendition.pdf',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      document: accessDoc(),
    });

    const ticket = await svc.getVersionViewTicket('doc-1', 'v-1', actor, reqCtx);

    expect(prisma.documentVersion.findFirst.mock.calls[0][0].where).toEqual({
      id: 'v-1',
      documentId: 'doc-1',
      document: { deletedAt: null },
    });
    expect(s3.getPresignedDownloadUrl).toHaveBeenCalledWith(
      'renditions/doc-1/v1/rendition.pdf',
      300,
    );
    expect(ticket).toEqual({
      url: 'https://minio.local/signed?x=1',
      expiresIn: 300,
      mimeType: 'application/pdf',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'document.viewed', versionId: 'v-1' }),
    );
  });

  it('403s + audits access.denied when the caller cannot view', async () => {
    const { svc, prisma, s3, access, audit } = build();
    prisma.documentVersion.findFirst.mockResolvedValue({
      s3Key: 'k',
      renditionS3Key: 'r',
      mimeType: 'application/pdf',
      document: accessDoc({ accessLevel: 'confidential' }),
    });
    access.canAccess.mockResolvedValue(false);
    await expect(svc.getVersionViewTicket('doc-1', 'v-1', actor, reqCtx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(s3.getPresignedDownloadUrl).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'access.denied' }),
    );
  });

  it('serves a source PDF directly when it needs no rendition', async () => {
    const { svc, prisma, s3 } = build();
    prisma.documentVersion.findFirst.mockResolvedValue({
      s3Key: 'documents/doc-1/v1/policy.pdf',
      renditionS3Key: null,
      mimeType: 'application/pdf',
      document: accessDoc(),
    });
    const ticket = await svc.getVersionViewTicket('doc-1', 'v-1', actor, reqCtx);
    expect(s3.getPresignedDownloadUrl).toHaveBeenCalledWith('documents/doc-1/v1/policy.pdf', 300);
    expect(ticket.mimeType).toBe('application/pdf');
  });

  it('serves a source image with its own mime type', async () => {
    const { svc, prisma } = build();
    prisma.documentVersion.findFirst.mockResolvedValue({
      s3Key: 'documents/doc-1/v1/scan.png',
      renditionS3Key: null,
      mimeType: 'image/png',
      document: accessDoc(),
    });
    const ticket = await svc.getVersionViewTicket('doc-1', 'v-1', actor, reqCtx);
    expect(ticket.mimeType).toBe('image/png');
  });

  it('404s an office source that has no rendition yet (not viewable)', async () => {
    const { svc, prisma } = build();
    prisma.documentVersion.findFirst.mockResolvedValue({
      s3Key: 'documents/doc-1/v1/policy.docx',
      renditionS3Key: null,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      document: accessDoc(),
    });
    await expect(svc.getVersionViewTicket('doc-1', 'v-1', actor, reqCtx)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('404s when the version is not under the (non-deleted) document', async () => {
    const { svc, prisma, s3 } = build();
    prisma.documentVersion.findFirst.mockResolvedValue(null);
    await expect(svc.getVersionViewTicket('doc-1', 'ghost', actor, reqCtx)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(s3.getPresignedDownloadUrl).not.toHaveBeenCalled();
  });
});

describe('DocumentsService.getEditorConfig', () => {
  it('enforces edit then builds a signed config for an editable current version', async () => {
    const { svc, prisma, onlyOffice, access } = build();
    prisma.document.findFirst.mockResolvedValue({
      ...accessDoc(),
      currentVersion: { id: 'v-1', fileName: 'policy.docx' },
    });
    const cfg = await svc.getEditorConfig('doc-1', actor, reqCtx);
    expect(access.canAccess).toHaveBeenCalledWith(actor, expect.objectContaining({ id: 'doc-1' }), 'edit');
    expect(onlyOffice.buildEditorConfig).toHaveBeenCalledWith({
      documentId: 'doc-1',
      versionId: 'v-1',
      fileName: 'policy.docx',
      documentType: 'word',
      user: { id: 'user-admin', name: 'Admin' },
    });
    expect(cfg).toEqual({ token: 'signed' });
  });

  it('403s when the caller cannot edit (no config built)', async () => {
    const { svc, prisma, onlyOffice, access } = build();
    prisma.document.findFirst.mockResolvedValue({
      ...accessDoc({ accessLevel: 'confidential' }),
      currentVersion: { id: 'v-1', fileName: 'policy.docx' },
    });
    access.canAccess.mockResolvedValue(false);
    await expect(svc.getEditorConfig('doc-1', actor, reqCtx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(onlyOffice.buildEditorConfig).not.toHaveBeenCalled();
  });

  it('400s when the current version is not an editable Office type', async () => {
    const { svc, prisma, onlyOffice } = build();
    prisma.document.findFirst.mockResolvedValue({
      ...accessDoc(),
      currentVersion: { id: 'v-1', fileName: 'policy.pdf' },
    });
    await expect(svc.getEditorConfig('doc-1', actor, reqCtx)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(onlyOffice.buildEditorConfig).not.toHaveBeenCalled();
  });

  it('400s when the document has no version to edit', async () => {
    const { svc, prisma } = build();
    prisma.document.findFirst.mockResolvedValue({ ...accessDoc(), currentVersion: null });
    await expect(svc.getEditorConfig('doc-1', actor, reqCtx)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('404s for a missing/soft-deleted document', async () => {
    const { svc, prisma } = build();
    prisma.document.findFirst.mockResolvedValue(null);
    await expect(svc.getEditorConfig('gone', actor, reqCtx)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('DocumentsService.applyEditorCallback (save => new version)', () => {
  it('acks non-save statuses WITHOUT creating a version', async () => {
    const { svc, prisma, onlyOffice, audit } = build();
    for (const status of [1, 3, 4, 7]) {
      const res = await svc.applyEditorCallback('doc-1', 'v-1', { status }, 'u-ed');
      expect(res).toEqual({ error: 0 });
    }
    expect(onlyOffice.downloadEditedFile).not.toHaveBeenCalled();
    expect(prisma.documentVersion.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('on status 2 writes a NEW immutable version and audits document.edited (source=system)', async () => {
    const { svc, prisma, s3, onlyOffice, audit } = build();
    prisma.documentVersion.findFirst.mockResolvedValue({
      fileName: 'policy.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      document: { ownerId: 'owner-1' },
    });
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
    const createArg = prisma.documentVersion.create.mock.calls[0][0];
    expect(createArg.data.versionNumber).toBe(3);
    expect(createArg.data.changeSummary).toBe('Edited in OnlyOffice');
    expect(createArg.data.uploadedById).toBe('u-editor');
    expect(s3.putObject).toHaveBeenCalled();
    expect(prisma.document.update).toHaveBeenCalledWith({
      where: { id: 'doc-1' },
      data: { currentVersion: { connect: { id: 'v-3' } } },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'document.edited',
        source: 'system',
        actorUserId: 'u-editor',
        versionId: 'v-3',
      }),
    );
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
  it('enforces view then returns the HTML for a text/html version', async () => {
    const { svc, prisma, s3, access } = build();
    prisma.documentVersion.findFirst.mockResolvedValue({
      s3Key: 'documents/doc-1/v1/document.html',
      mimeType: 'text/html',
      document: accessDoc(),
    });
    s3.getObjectBuffer.mockResolvedValue(Buffer.from('<h1>Hi</h1>'));
    const result = await svc.getVersionHtml('doc-1', 'v-1', actor, reqCtx);
    expect(access.canAccess).toHaveBeenCalledWith(actor, accessDoc(), 'view');
    expect(result).toEqual({ html: '<h1>Hi</h1>' });
  });

  it('400s a non-HTML version (not editable as text)', async () => {
    const { svc, prisma, s3 } = build();
    prisma.documentVersion.findFirst.mockResolvedValue({
      s3Key: 'documents/doc-1/v1/policy.pdf',
      mimeType: 'application/pdf',
      document: accessDoc(),
    });
    await expect(svc.getVersionHtml('doc-1', 'v-1', actor, reqCtx)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(s3.getObjectBuffer).not.toHaveBeenCalled();
  });

  it('404s when the version is not under the (non-deleted) document', async () => {
    const { svc, prisma } = build();
    prisma.documentVersion.findFirst.mockResolvedValue(null);
    await expect(svc.getVersionHtml('doc-1', 'ghost', actor, reqCtx)).rejects.toBeInstanceOf(
      NotFoundException,
    );
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
    const { svc, prisma, s3, audit } = build();
    prisma.document.findFirst.mockResolvedValue(accessDoc()); // loadAccessDoc
    prisma.documentVersion.aggregate.mockResolvedValue({ _max: { versionNumber: null } });
    prisma.documentVersion.create.mockResolvedValue(
      versionRow({ id: 'v-1', fileName: 'document.html', mimeType: 'text/html' }),
    );
    prisma.document.update.mockResolvedValue({});

    await svc.addHtmlVersion('doc-1', '<h1>Hello</h1>', 'First draft', actor, reqCtx);

    const putArgs = s3.putObject.mock.calls[0];
    expect(putArgs[2]).toBe('text/html');
    expect(putArgs[1].toString()).toBe('<h1>Hello</h1>');
    const createArg = prisma.documentVersion.create.mock.calls[0][0];
    expect(createArg.data.mimeType).toBe('text/html');
    expect(createArg.data.fileName).toBe('document.html');
    expect(createArg.data.changeSummary).toBe('First draft');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'version.uploaded', documentId: 'doc-1' }),
    );
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
  it('ANDs the access filter into the query and returns a mapped envelope', async () => {
    const { svc, prisma, access } = build();
    access.buildListWhere.mockResolvedValue({ some: 'access-clause' });
    prisma.document.findMany.mockResolvedValue([fullDocRow()]);
    prisma.document.count.mockResolvedValue(1);

    const result = await svc.list({ page: 1, pageSize: 20, sort: 'title', order: 'asc' }, actor);

    expect(access.buildListWhere).toHaveBeenCalledWith(actor);
    expect(result).toMatchObject({ total: 1, page: 1, pageSize: 20 });
    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item.categoryName).toBe('Policies');
    expect(item.ownerName).toBe('Owner');
    expect(item.currentVersion?.versionNumber).toBe(1);
    expect(item.nextReviewDate).toBe('2026-09-01T00:00:00.000Z');
    const findArg = prisma.document.findMany.mock.calls[0][0];
    expect(findArg.take).toBe(20);
    expect(findArg.orderBy).toEqual({ title: 'asc' });
    // The access clause is ANDed with the built base where.
    expect(findArg.where.AND).toEqual([expect.any(Object), { some: 'access-clause' }]);
  });
});

describe('DocumentsService.update', () => {
  it('enforces edit, patches, and audits document.updated', async () => {
    const { svc, prisma, access, audit } = build();
    prisma.document.findFirst
      .mockResolvedValueOnce(accessDoc()) // loadAccessDoc
      .mockResolvedValueOnce(fullDocRow()); // loadDetail reload
    prisma.document.update.mockResolvedValue({});

    await svc.update(
      'doc-1',
      { title: 'New Title', status: 'published', tags: ['A', 'B'], categoryId: null, nextReviewDate: null },
      actor,
      reqCtx,
    );

    expect(access.canAccess).toHaveBeenCalledWith(actor, accessDoc(), 'edit');
    const data = prisma.document.update.mock.calls[0][0].data;
    expect(data.title).toBe('New Title');
    expect(data.status).toBe('published');
    expect(data.tags).toEqual(['A', 'B']);
    expect(data.category).toEqual({ disconnect: true });
    expect(data.nextReviewDate).toBeNull();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'document.updated', documentId: 'doc-1' }),
    );
  });

  it('connects a category and parses a provided review date', async () => {
    const { svc, prisma } = build();
    prisma.documentCategory.findUnique.mockResolvedValue({ id: 'cat-9' });
    prisma.document.findFirst
      .mockResolvedValueOnce(accessDoc())
      .mockResolvedValueOnce(fullDocRow());
    prisma.document.update.mockResolvedValue({});

    await svc.update('doc-1', { categoryId: 'cat-9', nextReviewDate: '2026-12-31' }, actor, reqCtx);

    const data = prisma.document.update.mock.calls[0][0].data;
    expect(data.category).toEqual({ connect: { id: 'cat-9' } });
    expect(data.nextReviewDate).toBeInstanceOf(Date);
  });

  it('404s for an unknown (or soft-deleted) document', async () => {
    const { svc, prisma } = build();
    prisma.document.findFirst.mockResolvedValue(null);
    await expect(svc.update('ghost', { title: 'x' }, actor, reqCtx)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('403s when the caller cannot edit a confidential document', async () => {
    const { svc, prisma, access } = build();
    prisma.document.findFirst.mockResolvedValue(accessDoc({ accessLevel: 'confidential' }));
    access.canAccess.mockResolvedValue(false);
    await expect(svc.update('doc-1', { title: 'x' }, actor, reqCtx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.document.update).not.toHaveBeenCalled();
  });
});

describe('DocumentsService.create', () => {
  it('rejects an unknown categoryId with 400 before writing', async () => {
    const { svc, prisma } = build();
    prisma.documentCategory.findUnique.mockResolvedValue(null);
    await expect(
      svc.create({ title: 'X', categoryId: 'nope' } as never, actor, reqCtx),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.document.create).not.toHaveBeenCalled();
  });

  it('stamps the owner from the caller and audits document.created', async () => {
    const { svc, prisma, audit } = build();
    prisma.document.create.mockResolvedValue({ id: 'doc-new' });
    prisma.document.findFirst.mockResolvedValue({
      id: 'doc-new',
      title: 'X',
      documentNumber: null,
      categoryId: null,
      ownerId: 'user-admin',
      description: null,
      status: 'draft',
      accessLevel: 'restricted',
      tags: [],
      reviewCadence: 'none',
      nextReviewDate: null,
      effectiveDate: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      deletedBy: null,
      category: null,
      owner: { name: 'Owner' },
      currentVersion: null,
      versions: [],
    });

    const detail = await svc.create({ title: 'X' } as never, actor, reqCtx);

    const createArg = prisma.document.create.mock.calls[0][0];
    expect(createArg.data.ownerId).toBe('user-admin');
    expect(createArg.data.tags).toEqual([]);
    expect(detail.id).toBe('doc-new');
    expect(detail.versions).toEqual([]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'document.created', documentId: 'doc-new' }),
    );
  });
});

describe('DocumentsService.get (soft-delete aware + access enforced)', () => {
  it('loads a non-deleted document, enforces view, and maps deletedAt', async () => {
    const { svc, prisma, access } = build();
    prisma.document.findFirst.mockResolvedValue(fullDocRow());

    const detail = await svc.get('doc-1', actor, reqCtx);

    const arg = prisma.document.findFirst.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 'doc-1', deletedAt: null });
    expect(access.canAccess).toHaveBeenCalledWith(
      actor,
      { id: 'doc-1', ownerId: 'owner-1', accessLevel: 'restricted', categoryId: 'cat-1' },
      'view',
    );
    expect(detail.deletedAt).toBeNull();
    expect(detail.deletedByName).toBeNull();
  });

  it('403s + audits access.denied for a confidential document the caller cannot view', async () => {
    const { svc, prisma, access, audit } = build();
    prisma.document.findFirst.mockResolvedValue(fullDocRow({ accessLevel: 'confidential' }));
    access.canAccess.mockResolvedValue(false);

    await expect(svc.get('doc-1', actor, reqCtx)).rejects.toBeInstanceOf(ForbiddenException);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'access.denied', documentId: 'doc-1' }),
    );
  });

  it('404s when the document is missing or soft-deleted', async () => {
    const { svc, prisma } = build();
    prisma.document.findFirst.mockResolvedValue(null);
    await expect(svc.get('gone', actor, reqCtx)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('DocumentsService.softDelete', () => {
  it('stamps deletedAt + deletedBy, audits, and never removes rows or bytes', async () => {
    const { svc, prisma, audit } = build();
    prisma.document.findFirst
      .mockResolvedValueOnce(accessDoc()) // access guard
      .mockResolvedValueOnce(
        fullDocRow({ deletedAt: new Date('2026-03-01T00:00:00Z'), deletedBy: { name: 'Admin' } }),
      );
    prisma.document.update.mockResolvedValue({});

    const detail = await svc.softDelete('doc-1', actor, reqCtx);

    const updateArg = prisma.document.update.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: 'doc-1' });
    expect(updateArg.data.deletedAt).toBeInstanceOf(Date);
    expect(updateArg.data.deletedBy).toEqual({ connect: { id: 'user-admin' } });
    expect(prisma.document.delete).toBeUndefined();
    expect(detail.deletedAt).toBe('2026-03-01T00:00:00.000Z');
    expect(detail.deletedByName).toBe('Admin');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'document.deleted', documentId: 'doc-1' }),
    );
  });

  it('404s (and does not write) when the document is already deleted/missing', async () => {
    const { svc, prisma } = build();
    prisma.document.findFirst.mockResolvedValue(null);
    await expect(svc.softDelete('gone', actor, reqCtx)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.document.update).not.toHaveBeenCalled();
  });
});

describe('DocumentsService.restore', () => {
  it('clears deletedAt/deletedById for a trashed document and audits', async () => {
    const { svc, prisma, audit } = build();
    prisma.document.findFirst
      .mockResolvedValueOnce(accessDoc()) // trashed guard
      .mockResolvedValueOnce(fullDocRow());
    prisma.document.update.mockResolvedValue({});

    await svc.restore('doc-1', actor, reqCtx);

    expect(prisma.document.findFirst.mock.calls[0][0].where).toEqual({
      id: 'doc-1',
      deletedAt: { not: null },
    });
    const updateArg = prisma.document.update.mock.calls[0][0];
    expect(updateArg.data).toEqual({ deletedAt: null, deletedById: null });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'document.restored' }),
    );
  });

  it('404s when the document is not in the trash', async () => {
    const { svc, prisma } = build();
    prisma.document.findFirst.mockResolvedValue(null);
    await expect(svc.restore('doc-1', actor, reqCtx)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.document.update).not.toHaveBeenCalled();
  });
});

describe('DocumentsService.archive / unarchive', () => {
  it('archives a published document, stashes prior status, and audits', async () => {
    const { svc, prisma, audit } = build();
    prisma.document.findFirst
      .mockResolvedValueOnce(accessDoc({ status: 'published' }))
      .mockResolvedValueOnce(fullDocRow({ status: 'archived' }));
    prisma.document.update.mockResolvedValue({});

    await svc.archive('doc-1', actor, reqCtx);

    const data = prisma.document.update.mock.calls[0][0].data;
    expect(data.status).toBe('archived');
    expect(data.preArchiveStatus).toBe('published');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'document.archived' }),
    );
  });

  it('archive is a no-op (no update/audit) when already archived', async () => {
    const { svc, prisma, audit } = build();
    prisma.document.findFirst
      .mockResolvedValueOnce(accessDoc({ status: 'archived' }))
      .mockResolvedValueOnce(fullDocRow({ status: 'archived' }));
    await svc.archive('doc-1', actor, reqCtx);
    expect(prisma.document.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('unarchive restores the stashed prior status and clears it', async () => {
    const { svc, prisma } = build();
    prisma.document.findFirst
      .mockResolvedValueOnce(accessDoc({ status: 'archived', preArchiveStatus: 'published' }))
      .mockResolvedValueOnce(fullDocRow({ status: 'published' }));
    prisma.document.update.mockResolvedValue({});

    await svc.unarchive('doc-1', actor, reqCtx);

    const data = prisma.document.update.mock.calls[0][0].data;
    expect(data.status).toBe('published');
    expect(data.preArchiveStatus).toBeNull();
  });

  it('unarchive falls back to draft when no prior status was stashed', async () => {
    const { svc, prisma } = build();
    prisma.document.findFirst
      .mockResolvedValueOnce(accessDoc({ status: 'archived', preArchiveStatus: null }))
      .mockResolvedValueOnce(fullDocRow({ status: 'draft' }));
    prisma.document.update.mockResolvedValue({});

    await svc.unarchive('doc-1', actor, reqCtx);

    expect(prisma.document.update.mock.calls[0][0].data.status).toBe('draft');
  });

  it('archive 404s for a missing/soft-deleted document', async () => {
    const { svc, prisma } = build();
    prisma.document.findFirst.mockResolvedValue(null);
    await expect(svc.archive('gone', actor, reqCtx)).rejects.toBeInstanceOf(NotFoundException);
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

  it('copies the old object to a NEW key, appends a new current version, and audits', async () => {
    const { svc, prisma, s3, audit } = build();
    prisma.document.findFirst.mockResolvedValue(accessDoc()); // access guard
    prisma.documentVersion.findFirst.mockResolvedValue(sourceVersion);
    prisma.documentVersion.aggregate.mockResolvedValue({ _max: { versionNumber: 2 } });
    prisma.documentVersion.create.mockResolvedValue(
      versionRow({ id: 'v-3', versionNumber: 3, changeSummary: 'Restored from v1' }),
    );
    prisma.document.update.mockResolvedValue({});

    const result = await svc.restoreVersion('doc-1', 'v-1', actor, reqCtx);

    expect(s3.buildDocumentKey).toHaveBeenCalledWith('doc-1', 3, 'policy.pdf');
    expect(s3.copyObject).toHaveBeenCalledWith(
      'documents/doc-1/v1/policy.pdf',
      'documents/doc-1/v3/policy.pdf',
      'application/pdf',
    );
    expect(s3.putObject).not.toHaveBeenCalled();

    const createArg = prisma.documentVersion.create.mock.calls[0][0];
    expect(createArg.data.versionNumber).toBe(3);
    expect(createArg.data.s3Key).toBe('documents/doc-1/v3/policy.pdf');
    expect(createArg.data.s3VersionId).toBe('s3-copy-ver');
    expect(createArg.data.checksum).toBe('sha-of-v1');
    expect(createArg.data.changeSummary).toBe('Restored from v1');
    expect(createArg.data.uploadedById).toBe('user-admin');
    expect(prisma.document.update).toHaveBeenCalledWith({
      where: { id: 'doc-1' },
      data: { currentVersion: { connect: { id: 'v-3' } } },
    });
    expect(result.versionNumber).toBe(3);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'version.restored', versionId: 'v-3' }),
    );
  });

  it('404s when the source version is not under the document (nothing copied)', async () => {
    const { svc, prisma, s3 } = build();
    prisma.document.findFirst.mockResolvedValue(accessDoc());
    prisma.documentVersion.findFirst.mockResolvedValue(null);
    await expect(svc.restoreVersion('doc-1', 'ghost', actor, reqCtx)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(s3.copyObject).not.toHaveBeenCalled();
    expect(prisma.documentVersion.create).not.toHaveBeenCalled();
  });

  it('404s when the parent document is missing/soft-deleted (nothing copied)', async () => {
    const { svc, prisma, s3 } = build();
    prisma.document.findFirst.mockResolvedValue(null);
    await expect(svc.restoreVersion('gone', 'v-1', actor, reqCtx)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.documentVersion.findFirst).not.toHaveBeenCalled();
    expect(s3.copyObject).not.toHaveBeenCalled();
  });
});
