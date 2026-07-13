import { NotFoundException } from '@nestjs/common';
import type { AuthenticatedApiClient } from '../api-clients/api-client.types';
import { buildSnippet, PublicDocumentsService } from './public-documents.service';

/**
 * Behavior tests for the public read-only data layer (AGENTS.md §8): the
 * visibility floor is applied on every read, content/download resolve the current
 * version (and 404 without one), and EVERY call is audited with source=api +
 * apiClientId.
 */
describe('PublicDocumentsService', () => {
  const client: AuthenticatedApiClient = {
    id: 'client-1',
    name: 'EMR',
    scopes: ['documents:read', 'content:read', 'download'],
    allowedCategoryIds: [],
  };

  const docRow = (over: Record<string, unknown> = {}) => ({
    id: 'doc-1',
    title: 'Seclusion & Restraint Policy',
    documentNumber: 'PP-042',
    categoryId: 'cat-1',
    status: 'published',
    accessLevel: 'restricted',
    tags: ['CARF'],
    effectiveDate: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-06-01T00:00:00Z'),
    category: { name: 'Policies' },
    currentVersion: { versionNumber: 3 },
    ...over,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const makePrisma = (): any => ({
    document: {
      findMany: jest.fn().mockResolvedValue([docRow()]),
      count: jest.fn().mockResolvedValue(1),
      findFirst: jest.fn().mockResolvedValue(docRow()),
    },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  });
  const makeS3 = () => ({
    getPresignedDownloadUrl: jest.fn().mockResolvedValue('https://minio.local/presigned?sig=1'),
  });
  const makeAudit = () => ({ record: jest.fn().mockResolvedValue('ae-1') });

  const build = (prisma = makePrisma(), s3 = makeS3(), audit = makeAudit()) => ({
    prisma,
    s3,
    audit,
    svc: new PublicDocumentsService(prisma as never, s3 as never, audit as never),
  });

  describe('list', () => {
    it('applies the published/non-confidential floor and audits source=api', async () => {
      const { svc, prisma, audit } = build();
      const page = await svc.list(client, { page: 1, pageSize: 20 }, { ipAddress: '1.2.3.4' });

      const where = prisma.document.findMany.mock.calls[0][0].where;
      expect(where.status).toBe('published');
      expect(where.deletedAt).toBeNull();
      expect(where.accessLevel).toEqual({ not: 'confidential' });

      expect(page.total).toBe(1);
      expect(page.items[0]).toMatchObject({
        id: 'doc-1',
        categoryName: 'Policies',
        version: 3,
        accessLevel: 'restricted',
      });

      const auditArg = audit.record.mock.calls[0][0];
      expect(auditArg).toMatchObject({
        action: 'api.documents.listed',
        source: 'api',
        apiClientId: 'client-1',
      });
    });

    it('scopes the query to the client allow-list when set', async () => {
      const { svc, prisma } = build();
      const scoped = { ...client, allowedCategoryIds: ['cat-1', 'cat-2'] };
      await svc.list(scoped, {});
      const where = prisma.document.findMany.mock.calls[0][0].where;
      expect(where.AND).toContainEqual({ categoryId: { in: ['cat-1', 'cat-2'] } });
    });
  });

  describe('get', () => {
    it('returns a visible document and audits api.document.read', async () => {
      const { svc, prisma, audit } = build();
      const doc = await svc.get(client, 'doc-1');
      // Visibility floor merged with the id lookup.
      const where = prisma.document.findFirst.mock.calls[0][0].where;
      expect(where.id).toBe('doc-1');
      expect(where.status).toBe('published');
      expect(doc.id).toBe('doc-1');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'api.document.read', source: 'api', documentId: 'doc-1' }),
      );
    });

    it('404s a document that is not visible', async () => {
      const prisma = makePrisma();
      prisma.document.findFirst.mockResolvedValue(null);
      const { svc } = build(prisma);
      await expect(svc.get(client, 'hidden')).rejects.toThrow(NotFoundException);
    });
  });

  describe('getContent', () => {
    it('returns extracted text and audits api.content.read', async () => {
      const prisma = makePrisma();
      prisma.document.findFirst.mockResolvedValue({
        currentVersion: { id: 'v3', versionNumber: 3, extractedText: 'the policy text' },
      });
      const { svc, audit } = build(prisma);
      const content = await svc.getContent(client, 'doc-1');
      expect(content).toMatchObject({
        documentId: 'doc-1',
        versionId: 'v3',
        version: 3,
        extractedText: 'the policy text',
        hasExtractedText: true,
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'api.content.read', source: 'api' }),
      );
    });

    it('returns an empty payload (hasExtractedText:false) when there is no current version', async () => {
      const prisma = makePrisma();
      prisma.document.findFirst.mockResolvedValue({ currentVersion: null });
      const { svc } = build(prisma);
      const content = await svc.getContent(client, 'doc-1');
      expect(content).toMatchObject({ extractedText: '', hasExtractedText: false, version: null });
    });
  });

  describe('getDownload', () => {
    it('presigns the current version and audits api.download.issued', async () => {
      const prisma = makePrisma();
      prisma.document.findFirst.mockResolvedValue({
        currentVersion: { versionNumber: 3, s3Key: 'documents/doc-1/v3/policy.pdf', fileName: 'policy.pdf' },
      });
      const { svc, s3, audit } = build(prisma);
      const ticket = await svc.getDownload(client, 'doc-1');
      expect(s3.getPresignedDownloadUrl).toHaveBeenCalledWith(
        'documents/doc-1/v3/policy.pdf',
        300,
        'policy.pdf',
      );
      expect(ticket).toMatchObject({ url: expect.stringMatching(/^https?:\/\//), expiresIn: 300, fileName: 'policy.pdf', version: 3 });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'api.download.issued', source: 'api' }),
      );
    });

    it('404s when the visible document has no current version', async () => {
      const prisma = makePrisma();
      prisma.document.findFirst.mockResolvedValue({ currentVersion: null });
      const { svc } = build(prisma);
      await expect(svc.getDownload(client, 'doc-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('getVersions', () => {
    it('maps version metadata and audits api.versions.read', async () => {
      const prisma = makePrisma();
      prisma.document.findFirst.mockResolvedValue({
        versions: [
          {
            versionNumber: 2,
            fileName: 'v2.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 100,
            checksum: 'abc',
            createdAt: new Date('2026-05-01T00:00:00Z'),
            // D2: getVersions now reads the persisted flag, not the text column.
            hasExtractedText: true,
          },
          {
            versionNumber: 1,
            fileName: 'v1.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 90,
            checksum: 'def',
            createdAt: new Date('2026-04-01T00:00:00Z'),
            hasExtractedText: false,
          },
        ],
      });
      const { svc, audit } = build(prisma);
      const versions = await svc.getVersions(client, 'doc-1');
      expect(versions).toHaveLength(2);
      expect(versions[0]).toMatchObject({ version: 2, hasExtractedText: true });
      expect(versions[1]).toMatchObject({ version: 1, hasExtractedText: false });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'api.versions.read', source: 'api' }),
      );
    });
  });

  describe('search', () => {
    it('returns scored hits with snippets and audits api.search', async () => {
      const prisma = makePrisma();
      prisma.document.findMany.mockResolvedValue([
        docRow({
          title: 'Unrelated Title',
          currentVersion: { versionNumber: 3, extractedText: 'lorem ipsum seclusion policy dolor sit amet' },
        }),
      ]);
      prisma.document.count.mockResolvedValue(1);
      const { svc, audit } = build(prisma);
      const res = await svc.search(client, 'seclusion', 1, 20, {});
      expect(res.query).toBe('seclusion');
      expect(res.total).toBe(1);
      expect(res.items[0].score).toBe(0.75); // content-only match
      expect(res.items[0].snippet).toContain('seclusion');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'api.search', source: 'api', metadata: expect.objectContaining({ q: 'seclusion' }) }),
      );
    });

    it('scores a title match above a content match', async () => {
      const prisma = makePrisma();
      prisma.document.findMany.mockResolvedValue([
        docRow({ title: 'Seclusion Policy', currentVersion: { versionNumber: 1, extractedText: null } }),
      ]);
      const { svc } = build(prisma);
      const res = await svc.search(client, 'seclusion', undefined, undefined, {});
      expect(res.items[0].score).toBe(1);
    });

    it('short-circuits an empty term (no DB query) but still audits', async () => {
      const { svc, prisma, audit } = build();
      const res = await svc.search(client, '   ', undefined, undefined, {});
      expect(res.items).toEqual([]);
      expect(res.total).toBe(0);
      expect(prisma.document.findMany).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'api.search' }),
      );
    });
  });

  describe('buildSnippet', () => {
    it('returns null for empty text', () => {
      expect(buildSnippet(null, 'x')).toBeNull();
    });
    it('windows around the match with ellipses', () => {
      const text = `${'a'.repeat(200)}NEEDLE${'b'.repeat(200)}`;
      const snip = buildSnippet(text, 'needle');
      expect(snip).toContain('NEEDLE');
      expect(snip?.startsWith('…')).toBe(true);
      expect(snip?.endsWith('…')).toBe(true);
    });
    it('falls back to the head when the term is absent (title-only match)', () => {
      expect(buildSnippet('short body', 'missing')).toBe('short body');
    });
  });
});
