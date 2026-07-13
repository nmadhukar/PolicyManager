import { ForbiddenException, Injectable, NotFoundException, StreamableFile } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import JSZip from 'jszip';
import { createHash } from 'crypto';
import {
  AUDIT_ACTIONS,
  PERMISSIONS,
  type AuthUser,
  type EvidenceBinderOptions,
} from '@policymanager/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestContext } from '../audit/request-context';
import { CoverPageService } from '../attestation/cover-page.service';
import { DocumentAccessService } from '../documents/document-access.service';
import { PrismaService } from '../prisma/prisma.service';
import { pdfSafeText } from '../common/pdf-text.util';

/** Caps so a synchronous binder export can't exhaust memory / stall the event loop. */
const MAX_BINDER_CSV_ROWS = 5000;
/** Max rows rendered into a PDF section (the ZIP CSV carries the complete set). */
const MAX_BINDER_PDF_LINES = 2000;

const docSelect = {
  id: true,
  title: true,
  documentNumber: true,
  ownerId: true,
  accessLevel: true,
  categoryId: true,
  currentVersionId: true,
  currentVersion: { select: { id: true, versionNumber: true } },
} satisfies Prisma.DocumentSelect;

type BinderDoc = Prisma.DocumentGetPayload<{ select: typeof docSelect }>;

@Injectable()
export class EvidenceBinderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: DocumentAccessService,
    private readonly coverPage: CoverPageService,
    private readonly audit: AuditService,
  ) {}

  async history(documentId: string, user: AuthUser): Promise<unknown[]> {
    this.assertCanExport(user);
    const doc = await this.loadDoc(documentId);
    await this.access.assertCanAccess(user, doc, 'view');
    const rows = await this.prisma.evidenceBinderJob.findMany({
      where: { documentId },
      include: { requestedBy: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return rows.map((r) => ({
      id: r.id,
      format: r.format,
      status: r.status,
      fileName: r.fileName,
      requestedByName: r.requestedBy?.name ?? null,
      createdAt: r.createdAt.toISOString(),
      completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    }));
  }

  async export(
    documentId: string,
    options: EvidenceBinderOptions,
    user: AuthUser,
    ctx: RequestContext = {},
  ): Promise<StreamableFile> {
    // Cheap coarse gate first (no DB hit), then load + fine-grained access checks.
    await this.assertExportPermission(documentId, user, ctx);
    const doc = await this.loadDoc(documentId);
    await this.authorizeDocumentAccess(doc, options, user, ctx);

    const opts = normalizeOptions(options);
    const fileName = `${fileStem(doc)}-evidence-binder.${opts.format === 'zip' ? 'zip' : 'pdf'}`;
    try {
      const buffer = opts.format === 'zip'
        ? await this.buildZip(doc, opts, user, ctx)
        : await this.buildPdf(doc, opts, user, ctx);
      await this.recordJob(doc, user, opts, fileName, 'completed', sha256(buffer));
      await this.audit.record({
        action: AUDIT_ACTIONS.EVIDENCE_BINDER_EXPORTED,
        actorUserId: user.id,
        documentId,
        versionId: doc.currentVersionId ?? undefined,
        targetType: 'evidence_binder',
        ...ctx,
        metadata: { format: opts.format, includedSections: opts },
      });
      return new StreamableFile(buffer, {
        type: opts.format === 'zip' ? 'application/zip' : 'application/pdf',
        disposition: `attachment; filename="${fileName}"`,
      });
    } catch (err) {
      await this.recordJob(doc, user, opts, fileName, 'failed', null, (err as Error).message);
      // A failed export is still an access event — record it so the audit trail isn't
      // silent on attempts that errored mid-generation.
      await this.audit.record({
        action: AUDIT_ACTIONS.EVIDENCE_BINDER_EXPORTED,
        actorUserId: user.id,
        documentId,
        versionId: doc.currentVersionId ?? undefined,
        targetType: 'evidence_binder',
        ...ctx,
        metadata: { format: opts.format, outcome: 'failed', error: (err as Error).message.slice(0, 500) },
      });
      throw err;
    }
  }

  /**
   * Coarse permission gate, checked BEFORE loading the document so an unauthorized
   * caller never triggers a DB read. Audits the denial (AGENTS.md §8).
   */
  private async assertExportPermission(
    documentId: string,
    user: AuthUser,
    ctx: RequestContext,
  ): Promise<void> {
    if (user.permissions.includes(PERMISSIONS.EVIDENCE_EXPORT)) return;
    await this.audit.record({
      action: AUDIT_ACTIONS.ACCESS_DENIED,
      actorUserId: user.id,
      documentId,
      targetType: 'evidence_binder',
      ...ctx,
      metadata: { attemptedAction: 'evidence.export', reason: 'evidence.export' },
    });
    throw new ForbiddenException('Evidence binder export requires evidence.export');
  }

  /**
   * Fine-grained confidential download access + audit-log gating on the loaded doc,
   * auditing an ACCESS_DENIED event on any denial (a denied evidence export on a
   * confidential document must not be silent).
   */
  private async authorizeDocumentAccess(
    doc: BinderDoc,
    options: EvidenceBinderOptions,
    user: AuthUser,
    ctx: RequestContext,
  ): Promise<void> {
    if (!(await this.access.canAccess(user, doc, 'download'))) {
      await this.auditDenied(doc, user, ctx, 'document.download');
      throw new ForbiddenException('You do not have access to this document');
    }
    if (options.includeAuditLog !== false && !user.permissions.includes(PERMISSIONS.AUDIT_READ)) {
      await this.auditDenied(doc, user, ctx, 'audit.read');
      throw new ForbiddenException('Audit log evidence requires audit.read');
    }
  }

  private async auditDenied(
    doc: BinderDoc,
    user: AuthUser,
    ctx: RequestContext,
    reason: string,
  ): Promise<void> {
    await this.audit.record({
      action: AUDIT_ACTIONS.ACCESS_DENIED,
      actorUserId: user.id,
      documentId: doc.id,
      targetType: 'evidence_binder',
      ...ctx,
      metadata: { attemptedAction: 'evidence.export', reason, accessLevel: doc.accessLevel },
    });
  }

  private async buildZip(
    doc: BinderDoc,
    options: EvidenceBinderOptions,
    user: AuthUser,
    ctx: RequestContext,
  ): Promise<Buffer> {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify(await this.manifest(doc, options), null, 2));
    if (options.includePolicyPdf) {
      const pdf = await this.coverPage.exportWithCoverPage(doc.id, user, ctx);
      zip.file('policy-with-cover.pdf', pdf.buffer);
    }
    if (options.includeCoverPage) {
      const cover = await this.coverPage.generateCoverPage(doc.id, user, ctx);
      zip.file('cover-page.pdf', cover.buffer);
    }
    if (options.includeApprovalChain) zip.file('approval-chain.csv', await this.approvalCsv(doc.id));
    if (options.includeAcknowledgmentRoster) zip.file('acknowledgment-roster.csv', await this.ackCsv(doc.id));
    if (options.includeReviewHistory) zip.file('review-history.csv', await this.reviewCsv(doc.id));
    if (options.includeRevisionHistory) zip.file('revision-history.csv', await this.revisionCsv(doc.id));
    if (options.includeAuditLog) zip.file('audit-log.csv', await this.auditCsv(doc.id));
    return zip.generateAsync({ type: 'nodebuffer' });
  }

  private async buildPdf(
    doc: BinderDoc,
    options: EvidenceBinderOptions,
    user: AuthUser,
    ctx: RequestContext,
  ): Promise<Buffer> {
    const base = options.includePolicyPdf
      ? (await this.coverPage.exportWithCoverPage(doc.id, user, ctx)).buffer
      : (await this.coverPage.generateCoverPage(doc.id, user, ctx)).buffer;
    const pdf = await PDFDocument.load(base, { ignoreEncryption: true });
    if (options.includeApprovalChain) await this.appendTextPage(pdf, 'Approval chain', await this.approvalCsv(doc.id));
    if (options.includeAcknowledgmentRoster) await this.appendTextPage(pdf, 'Acknowledgment roster', await this.ackCsv(doc.id));
    if (options.includeReviewHistory) await this.appendTextPage(pdf, 'Review history', await this.reviewCsv(doc.id));
    if (options.includeRevisionHistory) await this.appendTextPage(pdf, 'Revision history', await this.revisionCsv(doc.id));
    if (options.includeAuditLog) await this.appendTextPage(pdf, 'Audit log', await this.auditCsv(doc.id));
    return Buffer.from(await pdf.save());
  }

  private async appendTextPage(pdf: PDFDocument, title: string, csv: string): Promise<void> {
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    let page = pdf.addPage([612, 792]);
    let y = 738;
    // pdfSafeText keeps Word smart quotes / dashes / CJK from crashing drawText.
    page.drawText(pdfSafeText(title), { x: 54, y, size: 16, font: bold, color: rgb(0.08, 0.1, 0.15) });
    y -= 28;
    const lines = csv.split('\n');
    // Paginate across as many pages as needed (was capped at 55 lines on a single
    // page, silently dropping evidence). Bound the total so a huge roster can't
    // balloon the PDF; the ZIP export always carries the complete CSV.
    for (const line of lines.slice(0, MAX_BINDER_PDF_LINES)) {
      if (y < 54) {
        page = pdf.addPage([612, 792]);
        y = 738;
      }
      page.drawText(pdfSafeText(line).slice(0, 120), { x: 54, y, size: 8, font, color: rgb(0.18, 0.22, 0.29) });
      y -= 12;
    }
    if (lines.length > MAX_BINDER_PDF_LINES) {
      if (y < 54) {
        page = pdf.addPage([612, 792]);
        y = 738;
      }
      page.drawText(
        `... ${lines.length - MAX_BINDER_PDF_LINES} more row(s) omitted — use the ZIP export for the complete CSV.`,
        { x: 54, y, size: 8, font: bold, color: rgb(0.5, 0.1, 0.1) },
      );
    }
  }

  private async manifest(doc: BinderDoc, options: EvidenceBinderOptions) {
    return {
      documentId: doc.id,
      title: doc.title,
      documentNumber: doc.documentNumber,
      versionId: doc.currentVersionId,
      versionNumber: doc.currentVersion?.versionNumber ?? null,
      generatedAt: new Date().toISOString(),
      includedSections: options,
    };
  }

  private async approvalCsv(documentId: string): Promise<string> {
    const rows = await this.prisma.attestation.findMany({
      where: { documentId, action: { in: ['reviewed', 'approved'] } },
      include: { user: { select: { name: true, email: true } }, version: { select: { versionNumber: true } } },
      orderBy: { signedAt: 'asc' },
      take: MAX_BINDER_CSV_ROWS,
    });
    return csv(['action', 'name', 'role', 'email', 'version', 'signedAt', 'comments'], rows.map((r) => [
      r.action,
      r.signatureName,
      r.signatureRole,
      r.user?.email,
      r.version?.versionNumber,
      r.signedAt.toISOString(),
      r.comments,
    ]));
  }

  private async ackCsv(documentId: string): Promise<string> {
    const rows = await this.prisma.acknowledgmentAssignment.findMany({
      where: { documentId },
      include: { assignee: { select: { name: true, email: true } }, version: { select: { versionNumber: true } } },
      orderBy: [{ createdAt: 'desc' }],
      take: MAX_BINDER_CSV_ROWS,
    });
    return csv(['assignee', 'email', 'version', 'status', 'dueDate', 'completedAt'], rows.map((r) => [
      r.assignee?.name,
      r.assignee?.email,
      r.version?.versionNumber,
      r.status,
      r.dueDate?.toISOString(),
      r.completedAt?.toISOString(),
    ]));
  }

  private async reviewCsv(documentId: string): Promise<string> {
    const rows = await this.prisma.reviewTask.findMany({
      where: { documentId },
      include: { assignedTo: { select: { name: true, email: true } }, completedBy: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: MAX_BINDER_CSV_ROWS,
    });
    return csv(['assignedTo', 'email', 'status', 'dueDate', 'completedAt', 'completedBy', 'notes'], rows.map((r) => [
      r.assignedTo?.name,
      r.assignedTo?.email,
      r.status,
      r.dueDate.toISOString(),
      r.completedAt?.toISOString(),
      r.completedBy?.name,
      r.notes,
    ]));
  }

  private async revisionCsv(documentId: string): Promise<string> {
    const rows = await this.prisma.documentVersion.findMany({
      where: { documentId },
      include: { uploadedBy: { select: { name: true, email: true } } },
      orderBy: { versionNumber: 'desc' },
      take: MAX_BINDER_CSV_ROWS,
    });
    return csv(['version', 'fileName', 'mimeType', 'checksum', 'uploadedBy', 'createdAt', 'changeSummary'], rows.map((r) => [
      r.versionNumber,
      r.fileName,
      r.mimeType,
      r.checksum,
      r.uploadedBy?.name,
      r.createdAt.toISOString(),
      r.changeSummary,
    ]));
  }

  private async auditCsv(documentId: string): Promise<string> {
    const rows = await this.prisma.auditEvent.findMany({
      where: { documentId },
      include: { actor: { select: { name: true, email: true } } },
      orderBy: { createdAt: 'desc' },
      take: 1000,
    });
    return csv(['action', 'actor', 'email', 'source', 'versionId', 'createdAt'], rows.map((r) => [
      r.action,
      r.actor?.name,
      r.actor?.email,
      r.source,
      r.versionId,
      r.createdAt.toISOString(),
    ]));
  }

  private async loadDoc(documentId: string): Promise<BinderDoc> {
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, deletedAt: null },
      select: docSelect,
    });
    if (!doc) throw new NotFoundException('Document not found');
    return doc;
  }

  private assertCanExport(user: AuthUser): void {
    if (!user.permissions.includes(PERMISSIONS.EVIDENCE_EXPORT)) {
      throw new ForbiddenException('Evidence binder export requires evidence.export');
    }
  }

  private async recordJob(
    doc: BinderDoc,
    user: AuthUser,
    options: EvidenceBinderOptions,
    fileName: string,
    status: 'completed' | 'failed',
    checksum: string | null,
    errorMessage?: string,
  ): Promise<void> {
    await this.prisma.evidenceBinderJob.create({
      data: {
        documentId: doc.id,
        versionId: doc.currentVersionId ?? undefined,
        requestedById: user.id,
        format: options.format,
        status,
        includedSections: options as unknown as Prisma.InputJsonValue,
        fileName,
        checksum: checksum ?? undefined,
        errorMessage: errorMessage?.slice(0, 1000),
        completedAt: status === 'completed' ? new Date() : null,
      },
    });
  }
}

function normalizeOptions(options: EvidenceBinderOptions): EvidenceBinderOptions {
  return {
    format: options.format,
    includePolicyPdf: options.includePolicyPdf ?? true,
    includeCoverPage: options.includeCoverPage ?? true,
    includeApprovalChain: options.includeApprovalChain ?? true,
    includeAcknowledgmentRoster: options.includeAcknowledgmentRoster ?? true,
    includeReviewHistory: options.includeReviewHistory ?? true,
    includeRevisionHistory: options.includeRevisionHistory ?? true,
    includeAuditLog: options.includeAuditLog ?? true,
  };
}

function fileStem(doc: BinderDoc): string {
  return (doc.documentNumber || doc.title || 'document')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'document';
}

function csv(headers: string[], rows: unknown[][]): string {
  return [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
}

function csvCell(value: unknown): string {
  const raw = value == null ? '' : String(value);
  // Neutralize spreadsheet formula injection: a cell beginning with = + - @ (or a
  // tab/CR) is executed as a formula by Excel/Sheets. Prefix a single quote so
  // auditor-opened CSVs render it as literal text.
  const text = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}
