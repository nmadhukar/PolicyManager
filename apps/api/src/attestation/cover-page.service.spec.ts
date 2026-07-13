import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { AuthUser } from '@policymanager/shared';
import { CoverPageService } from './cover-page.service';

/**
 * Business-behavior tests for cover-page + export orchestration. Prisma, S3,
 * audit, access, and the attestation store are mocked to assert: access
 * enforcement, valid-PDF output, the merge (cover + source pages), the no-source
 * note-page fallback, and the audits.
 */
async function makePdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    doc.addPage([200, 200]).drawText(`p${i}`, { x: 20, y: 100, size: 12, font });
  }
  return Buffer.from(await doc.save());
}

describe('CoverPageService', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const makePrisma = (): any => ({ document: { findFirst: jest.fn() } });
  const makeS3 = () => ({ getObjectBuffer: jest.fn() });
  const makeAudit = () => ({ record: jest.fn().mockResolvedValue('ae-1') });
  const makeAccess = () => ({ canAccess: jest.fn().mockResolvedValue(true) });
  const makeAttestation = () => ({ listApprovalChain: jest.fn().mockResolvedValue([]) });

  const build = (
    prisma = makePrisma(),
    s3 = makeS3(),
    audit = makeAudit(),
    access = makeAccess(),
    attestation = makeAttestation(),
  ) => ({
    prisma,
    s3,
    audit,
    access,
    attestation,
    svc: new CoverPageService(
      prisma as never,
      s3 as never,
      audit as never,
      access as never,
      attestation as never,
    ),
  });

  const user: AuthUser = {
    id: 'u1',
    email: 'u@x.com',
    name: 'User',
    roles: ['Compliance Officer'],
    permissions: ['document.read'],
    mustChangePassword: false,
  };

  const docRow = (over: Record<string, unknown> = {}) => ({
    id: 'doc-1',
    title: 'Policy',
    documentNumber: 'PP-1',
    status: 'published',
    ownerId: 'owner-1',
    accessLevel: 'restricted',
    categoryId: null,
    reviewCadence: 'annual',
    nextReviewDate: new Date('2027-01-01T00:00:00Z'),
    effectiveDate: new Date('2026-01-01T00:00:00Z'),
    category: { name: 'P&P' },
    owner: { name: 'Owner' },
    currentVersion: {
      id: 'v-2',
      versionNumber: 2,
      s3Key: 'documents/doc-1/v2/policy.pdf',
      renditionS3Key: null,
      mimeType: 'application/pdf',
      fileName: 'policy.pdf',
    },
    versions: [
      { versionNumber: 2, createdAt: new Date('2026-02-01Z'), changeSummary: 'Rev', uploadedBy: { name: 'Owner' } },
    ],
    ...over,
  });

  const startsWithPdf = (buf: Buffer) => buf.subarray(0, 5).toString('latin1') === '%PDF-';

  it('generates a valid cover-page PDF and audits the view', async () => {
    const { svc, prisma, audit } = build();
    prisma.document.findFirst.mockResolvedValue(docRow());
    const { buffer, fileName } = await svc.generateCoverPage('doc-1', user, { ipAddress: '10.0.0.1' });
    expect(startsWithPdf(buffer)).toBe(true);
    expect(fileName).toContain('cover-page');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'document.viewed', metadata: expect.objectContaining({ artifact: 'cover-page' }) }),
    );
  });

  it('exports the cover prepended to the current PDF version (merged page count)', async () => {
    const { svc, prisma, s3, audit } = build();
    prisma.document.findFirst.mockResolvedValue(docRow());
    s3.getObjectBuffer.mockResolvedValue(await makePdf(3));

    const { buffer } = await svc.exportWithCoverPage('doc-1', user);
    expect(startsWithPdf(buffer)).toBe(true);
    const parsed = await PDFDocument.load(buffer);
    // Cover (>=1) + 3 source pages.
    expect(parsed.getPageCount()).toBeGreaterThanOrEqual(4);
    // Pulled the SOURCE key (it is a PDF, no rendition).
    expect(s3.getObjectBuffer).toHaveBeenCalledWith('documents/doc-1/v2/policy.pdf');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'document.downloaded', metadata: expect.objectContaining({ artifact: 'export' }) }),
    );
  });

  it('prefers the rendition key when present for the export', async () => {
    const { svc, prisma, s3 } = build();
    prisma.document.findFirst.mockResolvedValue(
      docRow({
        currentVersion: {
          id: 'v-2',
          versionNumber: 2,
          s3Key: 'documents/doc-1/v2/policy.docx',
          renditionS3Key: 'renditions/doc-1/v2/rendition.pdf',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          fileName: 'policy.docx',
        },
      }),
    );
    s3.getObjectBuffer.mockResolvedValue(await makePdf(1));
    await svc.exportWithCoverPage('doc-1', user);
    expect(s3.getObjectBuffer).toHaveBeenCalledWith('renditions/doc-1/v2/rendition.pdf');
  });

  it('falls back to a note page when the current version has no PDF body', async () => {
    const { svc, prisma, s3 } = build();
    prisma.document.findFirst.mockResolvedValue(
      docRow({
        currentVersion: {
          id: 'v-2',
          versionNumber: 2,
          s3Key: 'documents/doc-1/v2/notes.txt',
          renditionS3Key: null,
          mimeType: 'text/plain',
          fileName: 'notes.txt',
        },
      }),
    );
    const { buffer } = await svc.exportWithCoverPage('doc-1', user);
    expect(startsWithPdf(buffer)).toBe(true);
    // No PDF source => no S3 fetch, just cover + note page.
    expect(s3.getObjectBuffer).not.toHaveBeenCalled();
  });

  it('403s (with access.denied audit) when the caller cannot view the document', async () => {
    const { svc, prisma, access, audit } = build();
    prisma.document.findFirst.mockResolvedValue(docRow({ accessLevel: 'confidential' }));
    access.canAccess.mockResolvedValue(false);
    await expect(svc.generateCoverPage('doc-1', user, {})).rejects.toBeInstanceOf(ForbiddenException);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'access.denied' }),
    );
  });

  it('404s a missing/deleted document', async () => {
    const { svc, prisma } = build();
    prisma.document.findFirst.mockResolvedValue(null);
    await expect(svc.generateCoverPage('gone', user, {})).rejects.toBeInstanceOf(NotFoundException);
  });
});
