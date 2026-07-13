import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { AttestationItem } from '@policymanager/shared';
import {
  appendNotePage,
  appendSourcePdf,
  buildCoverDocument,
  buildCoverPageData,
  toBuffer,
  type CoverPageDocument,
  type CoverPageVersion,
} from './cover-page.util';

/** Builds a tiny valid single-page PDF for merge tests. */
async function makePdf(pages = 1): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([200, 200]);
    p.drawText(`page ${i + 1}`, { x: 20, y: 100, size: 12, font });
  }
  return Buffer.from(await doc.save());
}

const doc: CoverPageDocument = {
  title: 'Seclusion & Restraint Policy',
  documentNumber: 'PP-042',
  status: 'published',
  categoryName: 'Policies & Procedures',
  ownerName: 'Alex Owner',
  effectiveDate: '2026-01-15T00:00:00.000Z',
  reviewCadence: 'annual',
  nextReviewDate: '2027-01-15T00:00:00.000Z',
  currentVersionNumber: 2,
};

const attestations: AttestationItem[] = [
  {
    id: 'a2',
    documentId: 'd',
    versionId: 'v2',
    versionNumber: 2,
    reviewTaskId: 't1',
    acknowledgmentAssignmentId: null,
    userId: 'u1',
    userName: 'Dana',
    action: 'reviewed',
    signatureName: 'Dana Reviewer',
    signatureRole: 'RN',
    comments: null,
    ipAddress: '10.0.0.1',
    signedAt: '2026-02-01T00:00:00.000Z',
  },
  {
    id: 'a1',
    documentId: 'd',
    versionId: 'v2',
    versionNumber: 2,
    reviewTaskId: null,
    acknowledgmentAssignmentId: null,
    userId: 'u2',
    userName: 'Cleo',
    action: 'approved',
    signatureName: 'Cleo Approver',
    signatureRole: 'Compliance Officer',
    comments: 'ok',
    ipAddress: '10.0.0.2',
    signedAt: '2026-02-03T00:00:00.000Z',
  },
  // An acknowledgment must NOT appear in the approval chain.
  {
    id: 'a0',
    documentId: 'd',
    versionId: 'v2',
    versionNumber: 2,
    reviewTaskId: null,
    acknowledgmentAssignmentId: 'asg-1',
    userId: 'u3',
    userName: 'Sam',
    action: 'acknowledged',
    signatureName: 'Sam Staff',
    signatureRole: null,
    comments: null,
    ipAddress: '10.0.0.3',
    signedAt: '2026-02-05T00:00:00.000Z',
  },
];

const versions: CoverPageVersion[] = [
  { versionNumber: 1, createdAt: '2026-01-01T00:00:00.000Z', uploadedByName: 'Alex', changeSummary: 'Initial' },
  { versionNumber: 2, createdAt: '2026-01-20T00:00:00.000Z', uploadedByName: 'Alex', changeSummary: 'Revised' },
];

describe('buildCoverPageData', () => {
  const NOW = new Date('2026-07-13T12:00:00.000Z');

  it('maps all required compliance fields from live metadata (AGENTS.md §10)', () => {
    const data = buildCoverPageData(doc, attestations, versions, NOW);
    expect(data).toMatchObject({
      title: 'Seclusion & Restraint Policy',
      documentNumber: 'PP-042',
      version: 2,
      status: 'published',
      category: 'Policies & Procedures',
      owner: 'Alex Owner',
      effectiveDate: '2026-01-15T00:00:00.000Z',
      reviewCadence: 'annual',
      nextReviewDate: '2027-01-15T00:00:00.000Z',
      generatedAt: NOW.toISOString(),
    });
  });

  it('includes only reviewed/approved in the approval chain, oldest-first', () => {
    const data = buildCoverPageData(doc, attestations, versions, NOW);
    expect(data.approvalChain.map((a) => a.action)).toEqual(['reviewed', 'approved']);
    // Chronological (oldest signature first).
    expect(data.approvalChain[0].signedAt <= data.approvalChain[1].signedAt).toBe(true);
    expect(data.approvalChain.some((a) => a.action === 'acknowledged')).toBe(false);
  });

  it('orders revision history newest-version first', () => {
    const data = buildCoverPageData(doc, attestations, versions, NOW);
    expect(data.revisionHistory.map((r) => r.version)).toEqual([2, 1]);
    expect(data.revisionHistory[0]).toMatchObject({ uploadedBy: 'Alex', changeSummary: 'Revised' });
  });

  it('tolerates empty metadata (no owner/number/versions/attestations)', () => {
    const bare: CoverPageDocument = {
      title: 'Draft',
      documentNumber: null,
      status: 'draft',
      categoryName: null,
      ownerName: null,
      effectiveDate: null,
      reviewCadence: 'none',
      nextReviewDate: null,
      currentVersionNumber: null,
    };
    const data = buildCoverPageData(bare, [], [], NOW);
    expect(data.version).toBeNull();
    expect(data.approvalChain).toEqual([]);
    expect(data.revisionHistory).toEqual([]);
  });
});

describe('cover-page PDF rendering', () => {
  it('renders a valid, non-empty PDF (starts with %PDF)', async () => {
    const data = buildCoverPageData(doc, attestations, versions);
    const buffer = await toBuffer(await buildCoverDocument(data));
    expect(buffer.length).toBeGreaterThan(500);
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const parsed = await PDFDocument.load(buffer);
    expect(parsed.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it('paginates when the approval chain + revision history are long', async () => {
    const manyVersions: CoverPageVersion[] = Array.from({ length: 60 }, (_, i) => ({
      versionNumber: i + 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      uploadedByName: `User ${i}`,
      changeSummary: `Change number ${i}`,
    }));
    const data = buildCoverPageData(doc, attestations, manyVersions);
    const parsed = await PDFDocument.load(await toBuffer(await buildCoverDocument(data)));
    expect(parsed.getPageCount()).toBeGreaterThan(1);
  });
});

describe('export merge (cover prepended)', () => {
  it('produces a valid PDF whose page count = cover pages + source pages', async () => {
    const data = buildCoverPageData(doc, attestations, versions);
    const cover = await buildCoverDocument(data);
    const coverPages = cover.getPageCount();

    const source = await makePdf(3);
    await appendSourcePdf(cover, source);
    const merged = await toBuffer(cover);

    expect(merged.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const parsed = await PDFDocument.load(merged);
    expect(parsed.getPageCount()).toBe(coverPages + 3);
  });

  it('appends a single note page when there is no source PDF', async () => {
    const data = buildCoverPageData(doc, attestations, versions);
    const cover = await buildCoverDocument(data);
    const coverPages = cover.getPageCount();
    await appendNotePage(cover, 'No rendition available.');
    const parsed = await PDFDocument.load(await toBuffer(cover));
    expect(parsed.getPageCount()).toBe(coverPages + 1);
  });
});
