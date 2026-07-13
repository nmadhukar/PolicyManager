import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import {
  ATTESTATION_ACTION_LABELS,
  type AttestationItem,
  type CoverPageData,
  type DocumentStatus,
  type ReviewCadence,
} from '@policymanager/shared';

/** The document metadata slice the cover page renders. */
export interface CoverPageDocument {
  title: string;
  documentNumber: string | null;
  status: DocumentStatus;
  categoryName: string | null;
  ownerName: string | null;
  effectiveDate: string | null;
  reviewCadence: ReviewCadence;
  nextReviewDate: string | null;
  currentVersionNumber: number | null;
}

/** One revision-history row (a document version). */
export interface CoverPageVersion {
  versionNumber: number;
  createdAt: string;
  uploadedByName: string | null;
  changeSummary: string | null;
}

/**
 * PURE assembly of the cover-page data model from live metadata (AGENTS.md §10).
 * Deliberately independent of pdf-lib so it is fully unit-testable and never
 * touches the source version bytes. Recent-access summaries are intentionally
 * omitted (opt-in only — they can expose internal access patterns).
 */
export function buildCoverPageData(
  doc: CoverPageDocument,
  attestations: AttestationItem[],
  versions: CoverPageVersion[],
  now: Date = new Date(),
): CoverPageData {
  return {
    title: doc.title,
    documentNumber: doc.documentNumber,
    version: doc.currentVersionNumber,
    status: doc.status,
    category: doc.categoryName,
    owner: doc.ownerName,
    effectiveDate: doc.effectiveDate,
    reviewCadence: doc.reviewCadence,
    nextReviewDate: doc.nextReviewDate,
    // Approval chain oldest-first reads as a chronological audit trail on the page.
    approvalChain: [...attestations]
      .filter((a) => a.action === 'reviewed' || a.action === 'approved')
      .sort((a, b) => a.signedAt.localeCompare(b.signedAt))
      .map((a) => ({
        action: a.action,
        signatureName: a.signatureName,
        signatureRole: a.signatureRole,
        signedAt: a.signedAt,
      })),
    revisionHistory: [...versions]
      .sort((a, b) => b.versionNumber - a.versionNumber)
      .map((v) => ({
        version: v.versionNumber,
        date: v.createdAt,
        uploadedBy: v.uploadedByName,
        changeSummary: v.changeSummary,
      })),
    generatedAt: now.toISOString(),
  };
}

/** Formats an ISO date as a short calendar date, or an em dash when absent. */
function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

const PAGE_WIDTH = 612; // US Letter
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const INK = rgb(0.09, 0.11, 0.16);
const MUTED = rgb(0.42, 0.46, 0.54);
const RULE = rgb(0.82, 0.85, 0.9);
const BRAND = rgb(0.15, 0.39, 0.92);
type Color = ReturnType<typeof rgb>;

/**
 * A downward-flowing text cursor that adds a fresh page when it runs out of
 * vertical space — so long approval chains / revision histories paginate cleanly
 * instead of overflowing a single page. `page`/`y` are public so callers can draw
 * multi-column rows at the current baseline after {@link rowBaseline}.
 */
class Layout {
  page: PDFPage;
  y: number;

  constructor(
    readonly pdf: PDFDocument,
    readonly font: PDFFont,
    readonly bold: PDFFont,
  ) {
    this.page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.y = PAGE_HEIGHT - MARGIN;
  }

  private ensure(space: number): void {
    if (this.y - space < MARGIN) {
      this.page = this.pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      this.y = PAGE_HEIGHT - MARGIN;
    }
  }

  gap(space: number): void {
    this.ensure(space);
    this.y -= space;
  }

  text(value: string, opts: { size?: number; bold?: boolean; color?: Color; x?: number } = {}): void {
    const size = opts.size ?? 11;
    this.ensure(size + 4);
    this.y -= size;
    this.page.drawText(value, {
      x: opts.x ?? MARGIN,
      y: this.y,
      size,
      font: opts.bold ? this.bold : this.font,
      color: opts.color ?? INK,
    });
    this.y -= 4;
  }

  /** A label:value metadata row with the value right-aligned in the content box. */
  keyValue(label: string, value: string): void {
    const size = 11;
    this.ensure(size + 6);
    this.y -= size;
    this.page.drawText(label, { x: MARGIN, y: this.y, size, font: this.font, color: MUTED });
    const valWidth = this.bold.widthOfTextAtSize(value, size);
    this.page.drawText(value, {
      x: PAGE_WIDTH - MARGIN - valWidth,
      y: this.y,
      size,
      font: this.bold,
      color: INK,
    });
    this.y -= 6;
  }

  rule(): void {
    this.ensure(10);
    this.y -= 6;
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: PAGE_WIDTH - MARGIN, y: this.y },
      thickness: 1,
      color: RULE,
    });
    this.y -= 4;
  }

  /**
   * Paginates if needed then drops the cursor by `size` so the caller can draw a
   * multi-column table row at `this.y` on `this.page`. Caller advances trailing
   * spacing itself.
   */
  rowBaseline(size: number): void {
    this.ensure(size + 6);
    this.y -= size;
  }
}

/** Truncates a string to fit a column, adding an ellipsis when clipped. */
function clip(font: PDFFont, value: string, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(value, size) <= maxWidth) return value;
  let out = value;
  while (out.length > 1 && font.widthOfTextAtSize(`${out}…`, size) > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}…`;
}

/**
 * Builds the (un-saved) cover-page PDFDocument from the assembled data. Returned
 * un-saved so the export path can append the source document's pages to the same
 * document (cover prepended) without a second load.
 */
export async function buildCoverDocument(data: CoverPageData): Promise<PDFDocument> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const L = new Layout(pdf, font, bold);

  L.text('COMPLIANCE COVER PAGE', { size: 10, bold: true, color: BRAND });
  L.gap(6);
  L.text(data.title, { size: 20, bold: true });
  if (data.documentNumber) L.text(data.documentNumber, { size: 12, color: MUTED });
  L.rule();
  L.gap(6);

  L.keyValue('Document number', data.documentNumber ?? '—');
  L.keyValue('Version', data.version != null ? `v${data.version}` : '—');
  L.keyValue('Status', data.status);
  L.keyValue('Category', data.category ?? 'Uncategorized');
  L.keyValue('Owner', data.owner ?? '—');
  L.keyValue('Effective date', fmtDate(data.effectiveDate));
  L.keyValue('Review cadence', data.reviewCadence);
  L.keyValue('Next review date', fmtDate(data.nextReviewDate));

  L.gap(16);
  L.text('Approval chain', { size: 13, bold: true });
  L.rule();
  if (data.approvalChain.length === 0) {
    L.text('No sign-offs recorded yet.', { size: 10, color: MUTED });
  } else {
    for (const a of data.approvalChain) {
      const who = a.signatureRole ? `${a.signatureName} (${a.signatureRole})` : a.signatureName;
      L.text(`${ATTESTATION_ACTION_LABELS[a.action]} — ${who}`, { size: 11, bold: true });
      L.text(`Signed ${fmtDate(a.signedAt)}`, { size: 9, color: MUTED });
      L.gap(4);
    }
  }

  L.gap(12);
  L.text('Revision history', { size: 13, bold: true });
  L.rule();
  if (data.revisionHistory.length === 0) {
    L.text('No versions yet.', { size: 10, color: MUTED });
  } else {
    const cols = { ver: MARGIN, date: MARGIN + 60, by: MARGIN + 190, summary: MARGIN + 320 };
    L.rowBaseline(9);
    L.page.drawText('VERSION', { x: cols.ver, y: L.y, size: 9, font: bold, color: MUTED });
    L.page.drawText('DATE', { x: cols.date, y: L.y, size: 9, font: bold, color: MUTED });
    L.page.drawText('UPLOADED BY', { x: cols.by, y: L.y, size: 9, font: bold, color: MUTED });
    L.page.drawText('CHANGE SUMMARY', { x: cols.summary, y: L.y, size: 9, font: bold, color: MUTED });
    L.y -= 6;
    L.rule();
    for (const v of data.revisionHistory) {
      const size = 10;
      L.rowBaseline(size);
      L.page.drawText(`v${v.version}`, { x: cols.ver, y: L.y, size, font, color: INK });
      L.page.drawText(fmtDate(v.date), { x: cols.date, y: L.y, size, font, color: INK });
      L.page.drawText(clip(font, v.uploadedBy ?? '—', size, 120), { x: cols.by, y: L.y, size, font, color: INK });
      L.page.drawText(clip(font, v.changeSummary ?? '—', size, PAGE_WIDTH - MARGIN - cols.summary), {
        x: cols.summary,
        y: L.y,
        size,
        font,
        color: INK,
      });
      L.y -= 6;
    }
  }

  L.gap(20);
  L.text(
    `Generated ${new Date(data.generatedAt).toLocaleString('en-US')} · PolicyManager compliance evidence`,
    { size: 8, color: MUTED },
  );

  return pdf;
}

/**
 * Appends the source document's pages AFTER the cover pages (cover prepended).
 * The source bytes are read-only inputs — copied, never mutated (AGENTS.md §10).
 */
export async function appendSourcePdf(cover: PDFDocument, sourceBytes: Buffer): Promise<void> {
  const src = await PDFDocument.load(sourceBytes, { ignoreEncryption: true });
  const pages = await cover.copyPages(src, src.getPageIndices());
  for (const page of pages) cover.addPage(page);
}

/** Adds a note page (used when a document has no viewable rendition to prepend). */
export async function appendNotePage(cover: PDFDocument, message: string): Promise<void> {
  const font = await cover.embedFont(StandardFonts.Helvetica);
  const bold = await cover.embedFont(StandardFonts.HelveticaBold);
  const page = cover.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  page.drawText('Document content', {
    x: MARGIN,
    y: PAGE_HEIGHT - MARGIN - 14,
    size: 14,
    font: bold,
    color: INK,
  });
  page.drawText(message, {
    x: MARGIN,
    y: PAGE_HEIGHT - MARGIN - 44,
    size: 11,
    font,
    color: MUTED,
    maxWidth: PAGE_WIDTH - MARGIN * 2,
    lineHeight: 15,
  });
}

/** Serialises a PDFDocument to a Node Buffer. */
export async function toBuffer(pdf: PDFDocument): Promise<Buffer> {
  return Buffer.from(await pdf.save());
}
