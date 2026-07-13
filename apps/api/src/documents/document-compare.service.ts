import { ForbiddenException, Injectable, NotFoundException, StreamableFile } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import {
  AUDIT_ACTIONS,
  type AuthUser,
  type PolicyDiffHunk,
  type VersionCompareMetadataChange,
  type VersionCompareResult,
} from '@policymanager/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestContext } from '../audit/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { DocumentAccessService, type AccessDocument } from './document-access.service';
import { buildLineDiff } from './document-compare.util';

const compareSelect = {
  id: true,
  documentId: true,
  versionNumber: true,
  fileName: true,
  mimeType: true,
  checksum: true,
  changeSummary: true,
  status: true,
  extractedText: true,
  hasExtractedText: true,
  extractionStatus: true,
  createdAt: true,
  uploadedBy: { select: { name: true } },
  document: {
    select: {
      id: true,
      title: true,
      ownerId: true,
      accessLevel: true,
      categoryId: true,
      deletedAt: true,
    },
  },
} satisfies Prisma.DocumentVersionSelect;

type CompareVersion = Prisma.DocumentVersionGetPayload<{ select: typeof compareSelect }>;

@Injectable()
export class DocumentCompareService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: DocumentAccessService,
    private readonly audit: AuditService,
  ) {}

  async compare(
    documentId: string,
    fromVersionId: string,
    toVersionId: string,
    user: AuthUser,
    ctx: RequestContext = {},
  ): Promise<VersionCompareResult> {
    const { from, to } = await this.loadPair(documentId, fromVersionId, toVersionId);
    await this.enforceView(user, from.document, ctx);

    const textAvailable =
      !!from.hasExtractedText &&
      !!to.hasExtractedText &&
      !!from.extractedText?.trim() &&
      !!to.extractedText?.trim();
    const warnings: string[] = [];
    if (!textAvailable) {
      warnings.push(
        'Text compare is limited because extracted text is missing for one or both versions.',
      );
    }

    const hunks = textAvailable ? buildLineDiff(from.extractedText, to.extractedText) : [];
    const summary = summarize(hunks);
    const result: VersionCompareResult = {
      documentId,
      documentTitle: from.document.title,
      fromVersionId: from.id,
      toVersionId: to.id,
      fromVersionNumber: from.versionNumber,
      toVersionNumber: to.versionNumber,
      textAvailable,
      warnings,
      summary,
      metadataChanges: metadataChanges(from, to),
      hunks,
    };

    await this.audit.record({
      action: AUDIT_ACTIONS.VERSION_COMPARE_VIEWED,
      actorUserId: user.id,
      documentId,
      versionId: to.id,
      targetType: 'version_compare',
      ...ctx,
      metadata: {
        fromVersionId: from.id,
        toVersionId: to.id,
        fromVersionNumber: from.versionNumber,
        toVersionNumber: to.versionNumber,
      },
    });
    return result;
  }

  async exportPdf(
    documentId: string,
    fromVersionId: string,
    toVersionId: string,
    user: AuthUser,
    ctx: RequestContext = {},
  ): Promise<StreamableFile> {
    const result = await this.compare(documentId, fromVersionId, toVersionId, user, ctx);
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const page = pdf.addPage([612, 792]);
    let y = 740;
    const draw = (text: string, size = 10, isBold = false) => {
      if (y < 60) return;
      page.drawText(text.slice(0, 100), {
        x: 54,
        y,
        size,
        font: isBold ? bold : font,
        color: rgb(0.08, 0.1, 0.15),
      });
      y -= size + 8;
    };
    draw('POLICY VERSION COMPARE', 10, true);
    draw(result.documentTitle, 18, true);
    draw(`v${result.fromVersionNumber} to v${result.toVersionNumber}`, 12);
    draw(
      `Added ${result.summary.added}  Removed ${result.summary.removed}  Changed ${result.summary.changed}`,
      11,
      true,
    );
    if (result.warnings.length > 0) result.warnings.forEach((w) => draw(`Warning: ${w}`, 9));
    draw('Metadata changes', 12, true);
    for (const c of result.metadataChanges) {
      draw(`${c.label}: ${c.oldValue ?? '-'} -> ${c.newValue ?? '-'}`, 9);
    }
    draw('Text changes', 12, true);
    for (const h of result.hunks.filter((h) => h.type !== 'unchanged').slice(0, 45)) {
      const marker = h.type === 'added' ? '+' : h.type === 'removed' ? '-' : '~';
      draw(`${marker} ${h.oldText ?? h.newText ?? ''}${h.type === 'changed' ? ` -> ${h.newText}` : ''}`, 8);
    }
    const buffer = Buffer.from(await pdf.save());

    await this.audit.record({
      action: AUDIT_ACTIONS.VERSION_COMPARE_EXPORTED,
      actorUserId: user.id,
      documentId,
      versionId: toVersionId,
      targetType: 'version_compare',
      ...ctx,
      metadata: { fromVersionId, toVersionId },
    });
    const fileName = `version-compare-v${result.fromVersionNumber}-v${result.toVersionNumber}.pdf`;
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `attachment; filename="${fileName}"`,
    });
  }

  private async loadPair(documentId: string, fromVersionId: string, toVersionId: string) {
    const rows = await this.prisma.documentVersion.findMany({
      where: { documentId, id: { in: [fromVersionId, toVersionId] }, document: { deletedAt: null } },
      select: compareSelect,
    });
    const from = rows.find((v) => v.id === fromVersionId);
    const to = rows.find((v) => v.id === toVersionId);
    if (!from || !to) throw new NotFoundException('Version not found');
    if (from.document.deletedAt || to.document.deletedAt) throw new NotFoundException('Document not found');
    return { from, to };
  }

  private async enforceView(
    user: AuthUser,
    doc: AccessDocument & { title?: string },
    ctx: RequestContext,
  ): Promise<void> {
    if (await this.access.canAccess(user, doc, 'view')) return;
    await this.audit.record({
      action: AUDIT_ACTIONS.ACCESS_DENIED,
      actorUserId: user.id,
      documentId: doc.id,
      targetType: 'version_compare',
      ...ctx,
      metadata: { attemptedAction: 'version.compare', accessLevel: doc.accessLevel },
    });
    throw new ForbiddenException('You do not have access to this document');
  }
}

function summarize(hunks: PolicyDiffHunk[]): VersionCompareResult['summary'] {
  return {
    added: hunks.filter((h) => h.type === 'added').length,
    removed: hunks.filter((h) => h.type === 'removed').length,
    changed: hunks.filter((h) => h.type === 'changed').length,
    unchanged: hunks.filter((h) => h.type === 'unchanged').length,
  };
}

function metadataChanges(from: CompareVersion, to: CompareVersion): VersionCompareMetadataChange[] {
  const fields: [keyof CompareVersion, string][] = [
    ['fileName', 'File name'],
    ['mimeType', 'MIME type'],
    ['checksum', 'Checksum'],
    ['changeSummary', 'Change summary'],
    ['status', 'Status'],
    ['extractionStatus', 'Extraction status'],
  ];
  return fields
    .map(([field, label]) => ({
      field: String(field),
      label,
      oldValue: valueOf(from[field]),
      newValue: valueOf(to[field]),
    }))
    .filter((change) => change.oldValue !== change.newValue);
}

function valueOf(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
