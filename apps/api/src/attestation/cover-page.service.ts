import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AUDIT_ACTIONS,
  type AuthUser,
  type CoverPageData,
} from '@policymanager/shared';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../storage/s3.service';
import { AuditService } from '../audit/audit.service';
import type { RequestContext } from '../audit/request-context';
import { DocumentAccessService, type AccessDocument } from '../documents/document-access.service';
import { AttestationService } from './attestation.service';
import {
  appendNotePage,
  appendSourcePdf,
  buildCoverPageData,
  buildCoverDocument,
  toBuffer,
} from './cover-page.util';

/** A generated PDF artifact (cover page or export) ready to stream. */
export interface GeneratedPdf {
  buffer: Buffer;
  fileName: string;
}

/** Document fields the cover page + export need (metadata, current version, versions). */
const coverSelect = {
  id: true,
  title: true,
  documentNumber: true,
  status: true,
  ownerId: true,
  accessLevel: true,
  categoryId: true,
  reviewCadence: true,
  nextReviewDate: true,
  effectiveDate: true,
  category: { select: { name: true } },
  owner: { select: { name: true } },
  currentVersion: {
    select: { id: true, versionNumber: true, s3Key: true, renditionS3Key: true, mimeType: true, fileName: true },
  },
  versions: {
    orderBy: { versionNumber: 'desc' },
    select: { versionNumber: true, createdAt: true, changeSummary: true, uploadedBy: { select: { name: true } } },
  },
} satisfies Prisma.DocumentSelect;

type CoverDoc = Prisma.DocumentGetPayload<{ select: typeof coverSelect }>;

/**
 * Generates compliance cover pages and cover-prepended exports from LIVE metadata
 * (AGENTS.md §10; skill coverpage-export). The controlled document version bytes
 * are never mutated — the cover is a fresh artifact and the source is merged by
 * copying pages. Access is enforced (confidential ACLs) before any artifact is
 * produced, and export is audited.
 */
@Injectable()
export class CoverPageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
    private readonly audit: AuditService,
    private readonly access: DocumentAccessService,
    private readonly attestation: AttestationService,
  ) {}

  /**
   * Builds the cover-page PDF for a document. Enforces VIEW access and audits the
   * generation (as a document view of a compliance artifact).
   */
  async generateCoverPage(
    documentId: string,
    user: AuthUser,
    ctx: RequestContext = {},
  ): Promise<GeneratedPdf> {
    const doc = await this.load(documentId);
    await this.enforce(user, doc, 'view', ctx);

    const data = await this.assembleData(doc);
    const coverDoc = await buildCoverDocument(data);
    const buffer = await toBuffer(coverDoc);

    await this.audit.record({
      action: AUDIT_ACTIONS.DOCUMENT_VIEWED,
      actorUserId: user.id,
      documentId,
      versionId: doc.currentVersion?.id ?? undefined,
      targetType: 'document',
      ...ctx,
      metadata: { artifact: 'cover-page' },
    });

    return { buffer, fileName: this.fileName(doc, 'cover-page') };
  }

  /**
   * Builds the cover page PREPENDED to the current version's PDF rendition, merged
   * into one PDF. Falls back to a note page when no rendition/PDF source exists.
   * Enforces DOWNLOAD access (the export embeds the actual content) and audits the
   * download.
   */
  async exportWithCoverPage(
    documentId: string,
    user: AuthUser,
    ctx: RequestContext = {},
  ): Promise<GeneratedPdf> {
    const doc = await this.load(documentId);
    await this.enforce(user, doc, 'download', ctx);

    const data = await this.assembleData(doc);
    const coverDoc = await buildCoverDocument(data);

    const sourceBytes = await this.currentVersionPdfBytes(doc);
    if (sourceBytes) {
      await appendSourcePdf(coverDoc, sourceBytes);
    } else {
      await appendNotePage(
        coverDoc,
        'No PDF rendition is available for the current version yet. Download the original file, ' +
          'or regenerate the rendition, to include the document body in this export.',
      );
    }
    const buffer = await toBuffer(coverDoc);

    await this.audit.record({
      action: AUDIT_ACTIONS.DOCUMENT_DOWNLOADED,
      actorUserId: user.id,
      documentId,
      versionId: doc.currentVersion?.id ?? undefined,
      targetType: 'document',
      ...ctx,
      metadata: { artifact: 'export', merged: !!sourceBytes },
    });

    return { buffer, fileName: this.fileName(doc, 'export') };
  }

  // ---- Helpers -------------------------------------------------------------

  /** Assembles the pure cover-page data model (metadata + approval chain + revisions). */
  private async assembleData(doc: CoverDoc): Promise<CoverPageData> {
    const attestations = await this.attestation.listApprovalChain(doc.id);
    return buildCoverPageData(
      {
        title: doc.title,
        documentNumber: doc.documentNumber,
        status: doc.status,
        categoryName: doc.category?.name ?? null,
        ownerName: doc.owner?.name ?? null,
        effectiveDate: doc.effectiveDate ? doc.effectiveDate.toISOString() : null,
        reviewCadence: doc.reviewCadence,
        nextReviewDate: doc.nextReviewDate ? doc.nextReviewDate.toISOString() : null,
        currentVersionNumber: doc.currentVersion?.versionNumber ?? null,
      },
      attestations,
      doc.versions.map((v) => ({
        versionNumber: v.versionNumber,
        createdAt: v.createdAt.toISOString(),
        uploadedByName: v.uploadedBy?.name ?? null,
        changeSummary: v.changeSummary,
      })),
    );
  }

  /**
   * The current version's PDF bytes for prepend: its rendition when present, else
   * the source when it is itself a PDF, else null (no viewable body). Never the
   * raw office bytes — those are not a PDF and cannot be page-merged.
   */
  private async currentVersionPdfBytes(doc: CoverDoc): Promise<Buffer | null> {
    const v = doc.currentVersion;
    if (!v) return null;
    const key = v.renditionS3Key ?? (v.mimeType === 'application/pdf' ? v.s3Key : null);
    if (!key) return null;
    try {
      return await this.s3.getObjectBuffer(key);
    } catch {
      return null;
    }
  }

  private async load(documentId: string): Promise<CoverDoc> {
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, deletedAt: null },
      select: coverSelect,
    });
    if (!doc) throw new NotFoundException('Document not found');
    return doc;
  }

  /** Access check + access.denied audit, mirroring DocumentsService.enforce. */
  private async enforce(
    user: AuthUser,
    doc: CoverDoc,
    action: 'view' | 'download',
    ctx: RequestContext,
  ): Promise<void> {
    const accessDoc: AccessDocument = {
      id: doc.id,
      ownerId: doc.ownerId,
      accessLevel: doc.accessLevel,
      categoryId: doc.categoryId,
    };
    if (await this.access.canAccess(user, accessDoc, action)) return;
    await this.audit.record({
      action: AUDIT_ACTIONS.ACCESS_DENIED,
      actorUserId: user.id,
      documentId: doc.id,
      targetType: 'document',
      ...ctx,
      metadata: { attemptedAction: action, accessLevel: doc.accessLevel, artifact: 'cover-page' },
    });
    throw new ForbiddenException('You do not have access to this document');
  }

  private fileName(doc: CoverDoc, kind: 'cover-page' | 'export'): string {
    const base = (doc.documentNumber || doc.title || 'document')
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80);
    return `${base || 'document'}-${kind}.pdf`;
  }
}
