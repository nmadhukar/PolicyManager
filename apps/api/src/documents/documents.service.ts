import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AUDIT_ACTIONS,
  type AccessAction,
  type AuthUser,
  type DocumentDetail,
  type DocumentListItem,
  type DocumentVersionSummary,
  type Paginated,
  type ViewTicket,
} from '@policymanager/shared';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../storage/s3.service';
import { AuditService } from '../audit/audit.service';
import type { RequestContext } from '../audit/request-context';
import { DocumentAccessService, type AccessDocument } from './document-access.service';
import { buildDocumentListQuery, type ListDocumentsQuery } from './document-query';
import type { CreateDocumentDto } from './dto/create-document.dto';
import type { CreateVersionDto } from './dto/create-version.dto';
import type { UpdateDocumentDto } from './dto/update-document.dto';
import {
  OnlyOfficeService,
  callbackWantsSave,
  onlyOfficeDocumentType,
  type OnlyOfficeCallbackBody,
} from './onlyoffice.service';
import { RenditionService } from './rendition.service';
import { TextExtractionService } from './text-extraction.service';
import { computeNextVersionNumber, sha256Hex } from './versioning.util';

/** In-memory file shape used by the shared version-write path. */
interface VersionBytes {
  originalname: string;
  mimetype: string;
  size?: number;
  buffer: Buffer;
}

/** Uploaded file shape (Express/Multer), narrowed to what we consume. */
export interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/** Presigned-download response contract. */
export interface DownloadTicket {
  url: string;
  expiresIn: number;
  fileName: string;
}

const DOWNLOAD_TTL_SECONDS = 300;
/** In-browser view URLs are equally short-lived (AGENTS.md §8). */
const VIEW_TTL_SECONDS = 300;

/** Version fields needed to build a summary — deliberately excludes the bytes. */
const versionSummarySelect = {
  id: true,
  versionNumber: true,
  fileName: true,
  mimeType: true,
  sizeBytes: true,
  checksum: true,
  changeSummary: true,
  status: true,
  createdAt: true,
  extractedText: true,
  renditionS3Key: true,
  uploadedBy: { select: { name: true } },
} satisfies Prisma.DocumentVersionSelect;

/** Access-relevant document fields joined onto a version lookup. */
const accessSelect = {
  id: true,
  ownerId: true,
  accessLevel: true,
  categoryId: true,
} satisfies Prisma.DocumentSelect;

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
    private readonly textExtraction: TextExtractionService,
    private readonly renditions: RenditionService,
    private readonly onlyOffice: OnlyOfficeService,
    private readonly access: DocumentAccessService,
    private readonly audit: AuditService,
  ) {}

  // ---- Reads ---------------------------------------------------------------

  /**
   * Paginated, filtered, sorted document library (AGENTS.md §10c list screen).
   * Confidential documents the caller has no grant for are filtered out
   * server-side (AGENTS.md §8) — UI hiding is never the boundary.
   */
  async list(query: ListDocumentsQuery, user: AuthUser): Promise<Paginated<DocumentListItem>> {
    const built = buildDocumentListQuery(query);
    const accessWhere = await this.access.buildListWhere(user);
    const where: Prisma.DocumentWhereInput = { AND: [built.where, accessWhere] };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.document.findMany({
        where,
        orderBy: built.orderBy,
        skip: built.skip,
        take: built.take,
        include: this.listInclude(),
      }),
      this.prisma.document.count({ where }),
    ]);
    return {
      items: rows.map((r) => this.toListItem(r)),
      total,
      page: built.page,
      pageSize: built.pageSize,
    };
  }

  /**
   * Full detail incl. the complete, newest-first version history. Excludes
   * soft-deleted documents (reads as 404) and enforces VIEW access — a
   * confidential document the caller cannot see returns 403 + access.denied audit
   * (AGENTS.md §8/§9).
   */
  async get(id: string, user: AuthUser, ctx: RequestContext = {}): Promise<DocumentDetail> {
    const detail = await this.loadDetail(id, { includeDeleted: false });
    await this.enforce(user, this.accessDocOf(detail), 'view', ctx);
    return detail;
  }

  /**
   * Loads a document's full detail. `includeDeleted` is used only by the internal
   * state-change methods (soft-delete/restore/archive) that have already
   * validated the delete state and need to return the (possibly deleted) row.
   * Does NOT enforce access — callers that expose it to a user must (see `get`).
   */
  private async loadDetail(
    id: string,
    { includeDeleted = false }: { includeDeleted?: boolean } = {},
  ): Promise<DocumentDetail> {
    const doc = await this.prisma.document.findFirst({
      where: { id, ...(includeDeleted ? {} : { deletedAt: null }) },
      include: {
        ...this.listInclude(),
        versions: {
          orderBy: { versionNumber: 'desc' },
          select: versionSummarySelect,
        },
      },
    });
    if (!doc) throw new NotFoundException('Document not found');
    return {
      ...this.toListItem(doc),
      description: doc.description,
      versions: doc.versions.map((v) => this.toVersionSummary(v)),
    };
  }

  // ---- Writes --------------------------------------------------------------

  /** Creates a document owned by the caller. Bytes are added via a version. */
  async create(
    dto: CreateDocumentDto,
    user: AuthUser,
    ctx: RequestContext = {},
  ): Promise<DocumentDetail> {
    if (dto.categoryId) await this.assertCategoryExists(dto.categoryId);
    try {
      const doc = await this.prisma.document.create({
        data: {
          title: dto.title,
          documentNumber: dto.documentNumber,
          categoryId: dto.categoryId,
          description: dto.description,
          tags: dto.tags ?? [],
          accessLevel: dto.accessLevel,
          reviewCadence: dto.reviewCadence,
          nextReviewDate: dto.nextReviewDate ? new Date(dto.nextReviewDate) : undefined,
          effectiveDate: dto.effectiveDate ? new Date(dto.effectiveDate) : undefined,
          ownerId: user.id,
        },
      });
      await this.audit.record({
        action: AUDIT_ACTIONS.DOCUMENT_CREATED,
        actorUserId: user.id,
        documentId: doc.id,
        targetType: 'document',
        ...ctx,
        metadata: { title: dto.title },
      });
      // Internal reload (no re-enforcement — the creator owns the new document).
      return this.loadDetail(doc.id);
    } catch (err) {
      throw this.mapWriteError(err);
    }
  }

  /** Partial metadata update. `tags` replaces the full set; dates accept null. */
  async update(
    id: string,
    dto: UpdateDocumentDto,
    user: AuthUser,
    ctx: RequestContext = {},
  ): Promise<DocumentDetail> {
    const current = await this.loadAccessDoc(id);
    await this.enforce(user, current, 'edit', ctx);
    if (dto.categoryId) await this.assertCategoryExists(dto.categoryId);

    const data: Prisma.DocumentUpdateInput = {};
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.documentNumber !== undefined) data.documentNumber = dto.documentNumber;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.tags !== undefined) data.tags = dto.tags;
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.accessLevel !== undefined) data.accessLevel = dto.accessLevel;
    if (dto.reviewCadence !== undefined) data.reviewCadence = dto.reviewCadence;
    if (dto.categoryId !== undefined) {
      data.category = dto.categoryId
        ? { connect: { id: dto.categoryId } }
        : { disconnect: true };
    }
    if (dto.nextReviewDate !== undefined) {
      data.nextReviewDate = dto.nextReviewDate ? new Date(dto.nextReviewDate) : null;
    }
    if (dto.effectiveDate !== undefined) {
      data.effectiveDate = dto.effectiveDate ? new Date(dto.effectiveDate) : null;
    }

    try {
      await this.prisma.document.update({ where: { id }, data });
    } catch (err) {
      throw this.mapWriteError(err);
    }
    await this.audit.record({
      action: AUDIT_ACTIONS.DOCUMENT_UPDATED,
      actorUserId: user.id,
      documentId: id,
      targetType: 'document',
      ...ctx,
      metadata: { fields: Object.keys(data) },
    });
    return this.loadDetail(id);
  }

  /**
   * Immutable version upload: stores new bytes at a fresh, deterministic key,
   * extracts text best-effort, records the version, and points the document at
   * it. Prior version bytes are NEVER overwritten (AGENTS.md §9). Requires EDIT
   * access to the document (RBAC + confidential ACL).
   */
  async addVersion(
    documentId: string,
    file: UploadedFile,
    dto: CreateVersionDto,
    user: AuthUser,
    ctx: RequestContext = {},
  ): Promise<DocumentVersionSummary> {
    const doc = await this.loadAccessDoc(documentId);
    await this.enforce(user, doc, 'edit', ctx);
    if (!file || !file.buffer) throw new BadRequestException('A file is required');
    const version = await this.writeVersion(documentId, file, dto.changeSummary, user.id);
    await this.audit.record({
      action: AUDIT_ACTIONS.VERSION_UPLOADED,
      actorUserId: user.id,
      documentId,
      versionId: version.id,
      targetType: 'version',
      ...ctx,
      metadata: { versionNumber: version.versionNumber, fileName: version.fileName },
    });
    return version;
  }

  /**
   * Saves an app-authored (TipTap) HTML document as a NEW immutable version
   * (fileName `.html`, mime `text/html`) and generates a PDF rendition via the
   * Gotenberg Chromium route. Save == new version (AGENTS.md §10a). Requires EDIT.
   */
  async addHtmlVersion(
    documentId: string,
    html: string,
    changeSummary: string | undefined,
    user: AuthUser,
    ctx: RequestContext = {},
  ): Promise<DocumentVersionSummary> {
    const doc = await this.loadAccessDoc(documentId);
    await this.enforce(user, doc, 'edit', ctx);
    if (typeof html !== 'string') throw new BadRequestException('html is required');
    const file: VersionBytes = {
      originalname: 'document.html',
      mimetype: 'text/html',
      buffer: Buffer.from(html, 'utf8'),
    };
    const version = await this.writeVersion(
      documentId,
      file,
      changeSummary ?? 'Edited text document',
      user.id,
    );
    await this.audit.record({
      action: AUDIT_ACTIONS.VERSION_UPLOADED,
      actorUserId: user.id,
      documentId,
      versionId: version.id,
      targetType: 'version',
      ...ctx,
      metadata: { versionNumber: version.versionNumber, source: 'tiptap' },
    });
    return version;
  }

  /**
   * Shared immutable-version write path used by uploads, TipTap saves, and
   * OnlyOffice save-backs. Stores bytes at a fresh deterministic key, extracts
   * text (best-effort), generates a PDF rendition (best-effort), records the
   * version row, and points the document at it. Never overwrites prior bytes.
   * Audit is emitted by the CALLERS (upload/tiptap/edit) so each gets its own
   * action label.
   */
  private async writeVersion(
    documentId: string,
    file: VersionBytes,
    changeSummary: string | undefined,
    uploadedById: string,
  ): Promise<DocumentVersionSummary> {
    const agg = await this.prisma.documentVersion.aggregate({
      where: { documentId },
      _max: { versionNumber: true },
    });
    const versionNumber = computeNextVersionNumber(agg._max.versionNumber);

    const checksum = sha256Hex(file.buffer);
    const sizeBytes = file.size ?? file.buffer.length;
    const mimeType = file.mimetype || 'application/octet-stream';
    const s3Key = this.s3.buildDocumentKey(documentId, versionNumber, file.originalname);

    // Store bytes first; if the DB write later fails, the object is simply an
    // unreferenced immutable blob (never overwritten) — safe to retry.
    const { versionId } = await this.s3.putObject(s3Key, file.buffer, mimeType);

    // Best-effort — must never crash the write.
    const extractedText = await this.textExtraction.extract(
      file.buffer,
      mimeType,
      file.originalname,
    );

    // Best-effort PDF rendition for uniform in-browser viewing. On failure the
    // key stays null and the original remains downloadable (AGENTS.md §10a).
    const rendition = await this.renditions.generateForVersion({
      documentId,
      versionNumber,
      mimeType,
      fileName: file.originalname,
      sourceS3Key: s3Key,
      sourceBuffer: file.buffer,
    });

    const version = await this.prisma.$transaction(async (tx) => {
      const created = await tx.documentVersion.create({
        data: {
          documentId,
          versionNumber,
          s3Key,
          s3VersionId: versionId,
          renditionS3Key: rendition.renditionS3Key ?? undefined,
          fileName: file.originalname,
          mimeType,
          sizeBytes,
          checksum,
          uploadedById,
          changeSummary,
          extractedText: extractedText.length > 0 ? extractedText : undefined,
        },
        select: versionSummarySelect,
      });
      await tx.document.update({
        where: { id: documentId },
        data: { currentVersion: { connect: { id: created.id } } },
      });
      return created;
    });

    return this.toVersionSummary(version);
  }

  /**
   * Regenerates the PDF rendition for a specific version on demand (e.g. after a
   * transient Gotenberg outage). Best-effort: returns the refreshed version
   * summary with `hasRendition` reflecting the outcome. Never mutates source
   * bytes — only the derived rendition object + the `renditionS3Key` pointer.
   */
  async regenerateRendition(
    documentId: string,
    versionId: string,
  ): Promise<DocumentVersionSummary> {
    const version = await this.prisma.documentVersion.findFirst({
      where: { id: versionId, documentId, document: { deletedAt: null } },
      select: { versionNumber: true, mimeType: true, fileName: true, s3Key: true },
    });
    if (!version) throw new NotFoundException('Version not found');

    const rendition = await this.renditions.generateForVersion({
      documentId,
      versionNumber: version.versionNumber,
      mimeType: version.mimeType,
      fileName: version.fileName,
      sourceS3Key: version.s3Key,
    });

    const updated = await this.prisma.documentVersion.update({
      where: { id: versionId },
      data: { renditionS3Key: rendition.renditionS3Key },
      select: versionSummarySelect,
    });
    return this.toVersionSummary(updated);
  }

  /**
   * Authorizes VIEW access then returns a SHORT-LIVED presigned URL for
   * in-browser VIEWING: the PDF rendition when present, the source when it is
   * itself a PDF, or the source image. Office/text sources without a rendition
   * yet are not viewable. The URL is inline (no attachment disposition). Bucket
   * stays private. Issuing a ticket is audited as `document.viewed`.
   */
  async getVersionViewTicket(
    documentId: string,
    versionId: string,
    user: AuthUser,
    ctx: RequestContext = {},
  ): Promise<ViewTicket> {
    const version = await this.prisma.documentVersion.findFirst({
      where: { id: versionId, documentId, document: { deletedAt: null } },
      select: { s3Key: true, renditionS3Key: true, mimeType: true, document: { select: accessSelect } },
    });
    if (!version) throw new NotFoundException('Version not found');
    await this.enforce(user, version.document, 'view', ctx, versionId);

    let key: string;
    let mimeType: string;
    if (version.renditionS3Key) {
      key = version.renditionS3Key;
      mimeType = 'application/pdf';
    } else if (version.mimeType === 'application/pdf') {
      key = version.s3Key;
      mimeType = 'application/pdf';
    } else if (version.mimeType.startsWith('image/')) {
      key = version.s3Key;
      mimeType = version.mimeType;
    } else {
      throw new NotFoundException(
        'No viewable rendition is available yet. Download the original, or regenerate the rendition.',
      );
    }

    const url = await this.s3.getPresignedDownloadUrl(key, VIEW_TTL_SECONDS);
    await this.audit.record({
      action: AUDIT_ACTIONS.DOCUMENT_VIEWED,
      actorUserId: user.id,
      documentId,
      versionId,
      targetType: 'version',
      ...ctx,
    });
    return { url, expiresIn: VIEW_TTL_SECONDS, mimeType };
  }

  /**
   * Returns the raw HTML of an app-authored (text/html) version for the TipTap
   * editor to load. Scoped to non-deleted documents; enforces VIEW access;
   * rejects non-HTML versions.
   */
  async getVersionHtml(
    documentId: string,
    versionId: string,
    user: AuthUser,
    ctx: RequestContext = {},
  ): Promise<{ html: string }> {
    const version = await this.prisma.documentVersion.findFirst({
      where: { id: versionId, documentId, document: { deletedAt: null } },
      select: { s3Key: true, mimeType: true, document: { select: accessSelect } },
    });
    if (!version) throw new NotFoundException('Version not found');
    await this.enforce(user, version.document, 'view', ctx, versionId);
    if (!version.mimeType.startsWith('text/html')) {
      throw new BadRequestException('This version is not an editable text document');
    }
    const buffer = await this.s3.getObjectBuffer(version.s3Key);
    return { html: buffer.toString('utf8') };
  }

  /**
   * Authorizes DOWNLOAD access then returns a SHORT-LIVED presigned URL. The
   * bucket stays private — bytes never stream through the API (AGENTS.md §8).
   * Issuing a ticket is audited as `document.downloaded`.
   */
  async getVersionDownloadTicket(
    documentId: string,
    versionId: string,
    user: AuthUser,
    ctx: RequestContext = {},
  ): Promise<DownloadTicket> {
    const version = await this.prisma.documentVersion.findFirst({
      // The parent-document join enforces soft-delete: a version of a trashed
      // document is not downloadable via the normal route (reads as 404).
      where: { id: versionId, documentId, document: { deletedAt: null } },
      select: { s3Key: true, fileName: true, document: { select: accessSelect } },
    });
    if (!version) throw new NotFoundException('Version not found');
    await this.enforce(user, version.document, 'download', ctx, versionId);

    const url = await this.s3.getPresignedDownloadUrl(
      version.s3Key,
      DOWNLOAD_TTL_SECONDS,
      version.fileName,
    );
    await this.audit.record({
      action: AUDIT_ACTIONS.DOCUMENT_DOWNLOADED,
      actorUserId: user.id,
      documentId,
      versionId,
      targetType: 'version',
      ...ctx,
      metadata: { fileName: version.fileName },
    });
    return { url, expiresIn: DOWNLOAD_TTL_SECONDS, fileName: version.fileName };
  }

  // ---- OnlyOffice edit-in-browser (AGENTS.md §10a) -------------------------

  /**
   * Builds the signed OnlyOffice editor config for a document's CURRENT version.
   * Rejects documents with no version, or whose current version is not an
   * editable Office type (docx/xlsx/pptx…). Enforces EDIT access (RBAC +
   * confidential ACL) beyond the controller's `document.write` guard.
   */
  async getEditorConfig(
    documentId: string,
    user: AuthUser,
    ctx: RequestContext = {},
  ): Promise<Record<string, unknown>> {
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, deletedAt: null },
      select: { ...accessSelect, currentVersion: { select: { id: true, fileName: true } } },
    });
    if (!doc) throw new NotFoundException('Document not found');
    await this.enforce(user, doc, 'edit', ctx);
    if (!doc.currentVersion) {
      throw new BadRequestException('Upload a version before editing');
    }
    const documentType = onlyOfficeDocumentType(doc.currentVersion.fileName);
    if (!documentType) {
      throw new BadRequestException('This document type cannot be edited in OnlyOffice');
    }
    return this.onlyOffice.buildEditorConfig({
      documentId,
      versionId: doc.currentVersion.id,
      fileName: doc.currentVersion.fileName,
      documentType,
      user: { id: user.id, name: user.name },
    });
  }

  /**
   * Returns a version's SOURCE bytes for the OnlyOffice content route. This is
   * called server-to-server (the Docs server fetches it), authorized by a scoped
   * signed token verified in the controller — NOT a user JWT. Still scoped to a
   * non-deleted document + matching version as defence in depth.
   */
  async getVersionSource(
    documentId: string,
    versionId: string,
  ): Promise<{ buffer: Buffer; mimeType: string; fileName: string }> {
    const version = await this.prisma.documentVersion.findFirst({
      where: { id: versionId, documentId, document: { deletedAt: null } },
      select: { s3Key: true, mimeType: true, fileName: true },
    });
    if (!version) throw new NotFoundException('Version not found');
    const buffer = await this.s3.getObjectBuffer(version.s3Key);
    return { buffer, mimeType: version.mimeType, fileName: version.fileName };
  }

  /**
   * Applies an authenticated OnlyOffice save callback. The scoped callback token
   * AND the Docs-server body signature are verified in the controller; this
   * consumes the already-authenticated body.
   *
   * On a save status (2/6) it downloads the edited bytes and stores them as a
   * BRAND-NEW immutable version (increment, changeSummary "Edited in OnlyOffice"),
   * advancing `currentVersionId` and regenerating the rendition. It NEVER
   * overwrites the edited version's bytes (AGENTS.md §10a). Non-save statuses are
   * acked with no version created. A successful save is audited as
   * `document.edited` (source=system — the Docs server calls this). Always returns
   * OnlyOffice's `{ error: 0 }`.
   */
  async applyEditorCallback(
    documentId: string,
    editedVersionId: string,
    body: OnlyOfficeCallbackBody,
    editorUserId: string | undefined,
  ): Promise<{ error: number }> {
    if (!callbackWantsSave(body.status)) {
      // 1 (editing), 4 (closed, no change), 3/7 (errors): nothing to persist.
      return { error: 0 };
    }
    if (!body.url) {
      throw new BadRequestException('Save callback missing document url');
    }

    // Resolve the edited version's name/mime + the fallback author, scoped to a
    // non-deleted document.
    const source = await this.prisma.documentVersion.findFirst({
      where: { id: editedVersionId, documentId, document: { deletedAt: null } },
      select: { fileName: true, mimeType: true, document: { select: { ownerId: true } } },
    });
    if (!source) throw new NotFoundException('Version not found');

    const buffer = await this.onlyOffice.downloadEditedFile(body.url);
    const file: VersionBytes = {
      originalname: source.fileName,
      mimetype: source.mimeType,
      buffer,
    };
    const uploadedById = editorUserId ?? source.document.ownerId;
    const version = await this.writeVersion(documentId, file, 'Edited in OnlyOffice', uploadedById);
    await this.audit.record({
      action: AUDIT_ACTIONS.DOCUMENT_EDITED,
      actorUserId: editorUserId ?? source.document.ownerId,
      documentId,
      versionId: version.id,
      targetType: 'version',
      source: 'system',
      metadata: { versionNumber: version.versionNumber, editor: 'onlyoffice' },
    });
    return { error: 0 };
  }

  // ---- Soft delete / restore / archive (AGENTS.md §9) ----------------------

  /**
   * Soft-deletes a document: stamps `deletedAt`/`deletedById` so it drops out of
   * default lists and reads, WITHOUT removing the row, its versions, or any S3
   * bytes. Fully reversible via {@link restore}. 404 if already deleted/missing.
   * Requires EDIT access; emits a `document.deleted` audit event.
   */
  async softDelete(id: string, user: AuthUser, ctx: RequestContext = {}): Promise<DocumentDetail> {
    const doc = await this.prisma.document.findFirst({
      where: { id, deletedAt: null },
      select: accessSelect,
    });
    if (!doc) throw new NotFoundException('Document not found');
    await this.enforce(user, doc, 'edit', ctx);

    await this.prisma.document.update({
      where: { id },
      data: { deletedAt: new Date(), deletedBy: { connect: { id: user.id } } },
    });
    await this.audit.record({
      action: AUDIT_ACTIONS.DOCUMENT_DELETED,
      actorUserId: user.id,
      documentId: id,
      targetType: 'document',
      ...ctx,
    });
    return this.loadDetail(id, { includeDeleted: true });
  }

  /**
   * Restores a soft-deleted document by clearing `deletedAt`/`deletedById`.
   * 404 if the document is not currently in the trash. Requires EDIT access;
   * emits a `document.restored` audit event.
   */
  async restore(id: string, user: AuthUser, ctx: RequestContext = {}): Promise<DocumentDetail> {
    const doc = await this.prisma.document.findFirst({
      where: { id, deletedAt: { not: null } },
      select: accessSelect,
    });
    if (!doc) throw new NotFoundException('Document not found');
    await this.enforce(user, doc, 'edit', ctx);

    await this.prisma.document.update({
      where: { id },
      data: { deletedAt: null, deletedById: null },
    });
    await this.audit.record({
      action: AUDIT_ACTIONS.DOCUMENT_RESTORED,
      actorUserId: user.id,
      documentId: id,
      targetType: 'document',
      ...ctx,
    });
    return this.loadDetail(id);
  }

  /**
   * Archives a document (status -> archived), stashing the prior status so the
   * change is reversible. Archived documents stay fully readable/downloadable but
   * are kept out of active lists. No-op if already archived. 404 if
   * missing/soft-deleted (restore it first). Requires EDIT; emits
   * `document.archived`.
   */
  async archive(id: string, user: AuthUser, ctx: RequestContext = {}): Promise<DocumentDetail> {
    const doc = await this.prisma.document.findFirst({
      where: { id, deletedAt: null },
      select: { ...accessSelect, status: true },
    });
    if (!doc) throw new NotFoundException('Document not found');
    await this.enforce(user, doc, 'edit', ctx);

    if (doc.status !== 'archived') {
      await this.prisma.document.update({
        where: { id },
        data: { status: 'archived', preArchiveStatus: doc.status },
      });
      await this.audit.record({
        action: AUDIT_ACTIONS.DOCUMENT_ARCHIVED,
        actorUserId: user.id,
        documentId: id,
        targetType: 'document',
        ...ctx,
      });
    }
    return this.loadDetail(id);
  }

  /**
   * Unarchives a document, restoring the status held before it was archived
   * (falling back to `draft` when none was stashed) and clearing the stash.
   * No-op if the document is not archived. 404 if missing/soft-deleted. Requires
   * EDIT; emits `document.unarchived`.
   */
  async unarchive(id: string, user: AuthUser, ctx: RequestContext = {}): Promise<DocumentDetail> {
    const doc = await this.prisma.document.findFirst({
      where: { id, deletedAt: null },
      select: { ...accessSelect, status: true, preArchiveStatus: true },
    });
    if (!doc) throw new NotFoundException('Document not found');
    await this.enforce(user, doc, 'edit', ctx);

    if (doc.status === 'archived') {
      await this.prisma.document.update({
        where: { id },
        data: { status: doc.preArchiveStatus ?? 'draft', preArchiveStatus: null },
      });
      await this.audit.record({
        action: AUDIT_ACTIONS.DOCUMENT_UNARCHIVED,
        actorUserId: user.id,
        documentId: id,
        targetType: 'document',
        ...ctx,
      });
    }
    return this.loadDetail(id);
  }

  /**
   * Restores an OLDER version as the new current version. The chosen version's
   * immutable bytes are COPIED (never moved/deleted) to a fresh, version-scoped
   * S3 key, and a brand-new DocumentVersion row is appended and made current.
   * History is strictly preserved — the version count only ever grows and no
   * prior row/object is mutated (AGENTS.md §9). Requires EDIT; emits
   * `version.restored`.
   *
   * Because the bytes are identical, the checksum is carried forward unchanged.
   */
  async restoreVersion(
    documentId: string,
    versionId: string,
    user: AuthUser,
    ctx: RequestContext = {},
  ): Promise<DocumentVersionSummary> {
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, deletedAt: null },
      select: accessSelect,
    });
    if (!doc) throw new NotFoundException('Document not found');
    await this.enforce(user, doc, 'edit', ctx);

    const source = await this.prisma.documentVersion.findFirst({
      where: { id: versionId, documentId },
      select: {
        versionNumber: true,
        s3Key: true,
        renditionS3Key: true,
        fileName: true,
        mimeType: true,
        sizeBytes: true,
        checksum: true,
        extractedText: true,
      },
    });
    if (!source) throw new NotFoundException('Version not found');

    const agg = await this.prisma.documentVersion.aggregate({
      where: { documentId },
      _max: { versionNumber: true },
    });
    const versionNumber = computeNextVersionNumber(agg._max.versionNumber);
    const s3Key = this.s3.buildDocumentKey(documentId, versionNumber, source.fileName);

    // Duplicate the source object to the new key — the original is untouched.
    const { versionId: s3VersionId } = await this.s3.copyObject(
      source.s3Key,
      s3Key,
      source.mimeType,
    );

    // Carry the source's PDF rendition forward too (identical bytes ⇒ identical
    // rendition), so the restored version is immediately viewable. Best-effort:
    // if the copy fails, viewing falls back to on-demand regeneration.
    let renditionS3Key: string | null = null;
    if (source.renditionS3Key) {
      const destRenditionKey = this.s3.buildRenditionKey(documentId, versionNumber);
      try {
        await this.s3.copyObject(source.renditionS3Key, destRenditionKey, 'application/pdf');
        renditionS3Key = destRenditionKey;
      } catch {
        renditionS3Key = null;
      }
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const version = await tx.documentVersion.create({
        data: {
          documentId,
          versionNumber,
          s3Key,
          s3VersionId,
          renditionS3Key: renditionS3Key ?? undefined,
          fileName: source.fileName,
          mimeType: source.mimeType,
          sizeBytes: source.sizeBytes,
          checksum: source.checksum,
          uploadedById: user.id,
          changeSummary: `Restored from v${source.versionNumber}`,
          extractedText: source.extractedText ?? undefined,
        },
        select: versionSummarySelect,
      });
      await tx.document.update({
        where: { id: documentId },
        data: { currentVersion: { connect: { id: version.id } } },
      });
      return version;
    });

    await this.audit.record({
      action: AUDIT_ACTIONS.VERSION_RESTORED,
      actorUserId: user.id,
      documentId,
      versionId: created.id,
      targetType: 'version',
      ...ctx,
      metadata: { fromVersion: source.versionNumber, newVersion: created.versionNumber },
    });
    return this.toVersionSummary(created);
  }

  // ---- Helpers -------------------------------------------------------------

  /**
   * Access check + access.denied audit in one place. On denial writes an
   * `access.denied` event (with the attempted action) then throws 403 — the
   * uniform enforcement point for confidential documents (AGENTS.md §8).
   */
  private async enforce(
    user: AuthUser,
    doc: AccessDocument,
    action: AccessAction,
    ctx: RequestContext,
    versionId?: string,
  ): Promise<void> {
    if (await this.access.canAccess(user, doc, action)) return;
    await this.audit.record({
      action: AUDIT_ACTIONS.ACCESS_DENIED,
      actorUserId: user.id,
      documentId: doc.id,
      versionId,
      targetType: 'document',
      ...ctx,
      metadata: { attemptedAction: action, accessLevel: doc.accessLevel },
    });
    throw new ForbiddenException('You do not have access to this document');
  }

  /** Loads the access-relevant fields of an ACTIVE document (404 if gone). */
  private async loadAccessDoc(id: string): Promise<AccessDocument> {
    const doc = await this.prisma.document.findFirst({
      where: { id, deletedAt: null },
      select: accessSelect,
    });
    if (!doc) throw new NotFoundException('Document not found');
    return doc;
  }

  /** Projects a loaded DocumentDetail onto the access-decision shape. */
  private accessDocOf(detail: DocumentDetail): AccessDocument {
    return {
      id: detail.id,
      ownerId: detail.ownerId,
      accessLevel: detail.accessLevel,
      categoryId: detail.categoryId,
    };
  }

  private listInclude() {
    return {
      category: { select: { name: true } },
      owner: { select: { name: true } },
      deletedBy: { select: { name: true } },
      currentVersion: { select: versionSummarySelect },
    } satisfies Prisma.DocumentInclude;
  }

  private async assertCategoryExists(id: string): Promise<void> {
    const found = await this.prisma.documentCategory.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!found) throw new BadRequestException('Unknown categoryId');
  }

  /** Maps Prisma unique-constraint errors to a clean 409. */
  private mapWriteError(err: unknown): Error {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return new ConflictException('A document with that document number already exists');
    }
    return err as Error;
  }

  private toVersionSummary(v: {
    id: string;
    versionNumber: number;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    checksum: string;
    changeSummary: string | null;
    status: string;
    createdAt: Date;
    extractedText: string | null;
    renditionS3Key: string | null;
    uploadedBy: { name: string } | null;
  }): DocumentVersionSummary {
    return {
      id: v.id,
      versionNumber: v.versionNumber,
      fileName: v.fileName,
      mimeType: v.mimeType,
      sizeBytes: v.sizeBytes,
      checksum: v.checksum,
      changeSummary: v.changeSummary,
      status: v.status as DocumentVersionSummary['status'],
      createdAt: v.createdAt.toISOString(),
      uploadedByName: v.uploadedBy?.name ?? null,
      // Expose ONLY existence — the extracted text itself is scope-gated and
      // never returned by these endpoints (AGENTS.md §8).
      hasExtractedText: !!v.extractedText && v.extractedText.length > 0,
      // A version is viewable in-browser when it has a PDF rendition or is itself
      // a PDF/image; the UI uses this to decide whether to offer "View".
      hasRendition:
        !!v.renditionS3Key ||
        v.mimeType === 'application/pdf' ||
        v.mimeType.startsWith('image/'),
    };
  }

  private toListItem(doc: {
    id: string;
    title: string;
    documentNumber: string | null;
    categoryId: string | null;
    ownerId: string;
    status: string;
    accessLevel: string;
    tags: string[];
    reviewCadence: string;
    nextReviewDate: Date | null;
    effectiveDate: Date | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
    deletedBy: { name: string } | null;
    category: { name: string } | null;
    owner: { name: string } | null;
    currentVersion: Parameters<DocumentsService['toVersionSummary']>[0] | null;
  }): DocumentListItem {
    return {
      id: doc.id,
      title: doc.title,
      documentNumber: doc.documentNumber,
      categoryId: doc.categoryId,
      categoryName: doc.category?.name ?? null,
      ownerId: doc.ownerId,
      ownerName: doc.owner?.name ?? null,
      status: doc.status as DocumentListItem['status'],
      accessLevel: doc.accessLevel as DocumentListItem['accessLevel'],
      tags: doc.tags,
      reviewCadence: doc.reviewCadence as DocumentListItem['reviewCadence'],
      nextReviewDate: doc.nextReviewDate ? doc.nextReviewDate.toISOString() : null,
      effectiveDate: doc.effectiveDate ? doc.effectiveDate.toISOString() : null,
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
      deletedAt: doc.deletedAt ? doc.deletedAt.toISOString() : null,
      deletedByName: doc.deletedBy?.name ?? null,
      currentVersion: doc.currentVersion ? this.toVersionSummary(doc.currentVersion) : null,
    };
  }
}
