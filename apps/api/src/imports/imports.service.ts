import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  type AuthUser,
  type ImportBatchDetail,
  type ImportBatchStatus,
  type ImportBatchSummary,
  type ImportItemResult,
  type ImportItemStatus,
  type Paginated,
} from '@policymanager/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { RequestContext } from '../audit/request-context';
import { DocumentsService, type UploadedFile } from '../documents/documents.service';
import type { CreateDocumentDto } from '../documents/dto/create-document.dto';
import { sha256Hex } from '../documents/versioning.util';
import { duplicateMessage, findDuplicate, type DedupeResult } from './dedupe';
import {
  parseManifest,
  splitCategoryPath,
  titleFromFileName,
  type ManifestRow,
} from './manifest';

/** The resolved outcome of processing one row/file, before it is persisted. */
interface RowOutcome {
  status: Extract<ImportItemStatus, 'created' | 'duplicate' | 'error'>;
  documentId: string | null;
  message: string;
}

/** Running tally of terminal row states, rolled up onto the batch at the end. */
interface Counters {
  created: number;
  duplicate: number;
  error: number;
}

/** The fields of one persisted report line. */
interface ItemData {
  rowNumber: number;
  title: string | null;
  documentNumber: string | null;
  categoryName: string | null;
  fileName: string | null;
  status: ImportItemStatus;
  documentId: string | null;
  message: string | null;
}

/**
 * Bulk import & consolidation (Phase 8). Ingests scattered documents via a CSV
 * manifest (files matched by name) or a manifest-less multi-file upload, with
 * per-row duplicate detection and error isolation. It REUSES {@link DocumentsService}
 * for document creation + immutable version upload (S3 storage, checksum, text
 * extraction, rendition) — no storage/versioning logic is duplicated here. All
 * routes are gated by `document.write` in the controller. Every run is audited as
 * `import.completed` with the summary counters.
 */
@Injectable()
export class ImportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documents: DocumentsService,
    private readonly audit: AuditService,
  ) {}

  // ---- Public entry points -------------------------------------------------

  /**
   * Runs a CSV-manifest import. The manifest is parsed up front (whole-file errors
   * → 400); each data row is then processed independently so one bad row records an
   * `error` item and the batch continues. Files are matched to rows by name.
   */
  async runManifestImport(
    manifest: UploadedFile | undefined,
    files: UploadedFile[],
    user: AuthUser,
    ctx: RequestContext = {},
  ): Promise<ImportBatchDetail> {
    if (!manifest || !manifest.buffer) {
      throw new BadRequestException('A CSV manifest file is required (field "manifest").');
    }
    const parsed = parseManifest(manifest.buffer);
    const totalRows = parsed.rows.length + parsed.errors.length;

    const batch = await this.prisma.importBatch.create({
      data: {
        createdById: user.id,
        fileName: manifest.originalname,
        totalRows,
        status: 'processing',
      },
      select: { id: true },
    });

    const filesByName = indexFiles(files);
    const categoryCache = new Map<string, string | null>();
    const counters: Counters = { created: 0, duplicate: 0, error: 0 };

    // Validation failures from parsing come first (deterministic report order).
    for (const err of parsed.errors) {
      counters.error += 1;
      await this.recordItem(batch.id, {
        rowNumber: err.rowNumber,
        title: err.title,
        documentNumber: err.documentNumber,
        categoryName: null,
        fileName: err.fileName,
        status: 'error',
        documentId: null,
        message: err.message,
      });
    }

    for (const row of parsed.rows) {
      const outcome = await this.processRowSafely(row, filesByName, categoryCache, user, ctx);
      counters[outcome.status] += 1;
      await this.recordItem(batch.id, {
        rowNumber: row.rowNumber,
        title: row.title,
        documentNumber: row.documentNumber ?? null,
        categoryName: row.category ?? null,
        fileName: row.fileName ?? null,
        status: outcome.status,
        documentId: outcome.documentId,
        message: outcome.message,
      });
    }

    return this.finalize(batch.id, counters, user, ctx, 'manifest');
  }

  /**
   * Runs a manifest-less bulk upload: each file becomes a Document titled from its
   * name, de-duplicated by checksum (and title+fileName). Errors are isolated per
   * file just like the manifest path.
   */
  async runBulkImport(
    files: UploadedFile[],
    user: AuthUser,
    ctx: RequestContext = {},
  ): Promise<ImportBatchDetail> {
    if (!files || files.length === 0) {
      throw new BadRequestException('At least one file is required (field "files").');
    }

    const batch = await this.prisma.importBatch.create({
      data: { createdById: user.id, fileName: null, totalRows: files.length, status: 'processing' },
      select: { id: true },
    });

    const counters: Counters = { created: 0, duplicate: 0, error: 0 };
    let rowNumber = 0;
    for (const file of files) {
      rowNumber += 1;
      const title = titleFromFileName(file.originalname);
      const outcome = await this.processBulkFileSafely(title, file, user, ctx);
      counters[outcome.status] += 1;
      await this.recordItem(batch.id, {
        rowNumber,
        title,
        documentNumber: null,
        categoryName: null,
        fileName: file.originalname,
        status: outcome.status,
        documentId: outcome.documentId,
        message: outcome.message,
      });
    }

    return this.finalize(batch.id, counters, user, ctx, 'bulk');
  }

  /** Paginated, newest-first batch history for the report list. */
  async listBatches(page = 1, pageSize = 20): Promise<Paginated<ImportBatchSummary>> {
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.importBatch.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { createdBy: { select: { name: true } } },
      }),
      this.prisma.importBatch.count(),
    ]);
    return { items: rows.map((r) => toSummary(r)), total, page, pageSize };
  }

  /** A batch plus its full per-row report (404 if unknown). */
  async getBatch(id: string): Promise<ImportBatchDetail> {
    const batch = await this.prisma.importBatch.findUnique({
      where: { id },
      include: {
        createdBy: { select: { name: true } },
        items: { orderBy: { rowNumber: 'asc' } },
      },
    });
    if (!batch) throw new NotFoundException('Import batch not found');
    return { ...toSummary(batch), items: batch.items.map((i) => toItemResult(i)) };
  }

  // ---- Row processing ------------------------------------------------------

  /** Wraps {@link processRow} so an unexpected throw becomes an `error` item. */
  private async processRowSafely(
    row: ManifestRow,
    filesByName: Map<string, UploadedFile>,
    categoryCache: Map<string, string | null>,
    user: AuthUser,
    ctx: RequestContext,
  ): Promise<RowOutcome> {
    try {
      return await this.processRow(row, filesByName, categoryCache, user, ctx);
    } catch (err) {
      return { status: 'error', documentId: null, message: errorMessage(err) };
    }
  }

  /**
   * Processes a single valid manifest row: matches its file, detects duplicates,
   * resolves the category + owner, and creates the document + first version via the
   * shared DocumentsService path.
   */
  private async processRow(
    row: ManifestRow,
    filesByName: Map<string, UploadedFile>,
    categoryCache: Map<string, string | null>,
    user: AuthUser,
    ctx: RequestContext,
  ): Promise<RowOutcome> {
    let file: UploadedFile | undefined;
    if (row.fileName) {
      file = filesByName.get(row.fileName);
      if (!file) {
        return {
          status: 'error',
          documentId: null,
          message: `File "${row.fileName}" referenced in the manifest was not uploaded.`,
        };
      }
    }

    const checksum = file ? sha256Hex(file.buffer) : undefined;
    const dup = await this.detectDuplicate({
      documentNumber: row.documentNumber,
      checksum,
      title: row.title,
      fileName: row.fileName,
    });
    if (dup) {
      return { status: 'duplicate', documentId: dup.documentId, message: duplicateMessage(dup.reason) };
    }

    const categoryId = row.category
      ? await this.resolveCategoryPath(row.category, categoryCache)
      : null;
    const ownerId = await this.resolveOwnerId(row.owner, user);

    const dto: CreateDocumentDto = {
      title: row.title,
      documentNumber: row.documentNumber,
      categoryId: categoryId ?? undefined,
      description: row.description,
      tags: row.tags,
      accessLevel: row.accessLevel,
      reviewCadence: row.reviewCadence,
    };

    return this.createDocumentWithOptionalFile(dto, file, ownerId, user, ctx);
  }

  /** Wraps bulk-file processing so an unexpected throw becomes an `error` item. */
  private async processBulkFileSafely(
    title: string,
    file: UploadedFile,
    user: AuthUser,
    ctx: RequestContext,
  ): Promise<RowOutcome> {
    try {
      const checksum = sha256Hex(file.buffer);
      const dup = await this.detectDuplicate({ checksum, title, fileName: file.originalname });
      if (dup) {
        return {
          status: 'duplicate',
          documentId: dup.documentId,
          message: duplicateMessage(dup.reason),
        };
      }
      return this.createDocumentWithOptionalFile({ title }, file, user.id, user, ctx);
    } catch (err) {
      return { status: 'error', documentId: null, message: errorMessage(err) };
    }
  }

  /**
   * Creates the Document (reusing DocumentsService), uploads the first immutable
   * version when a file is present, then re-assigns ownership if the manifest named
   * a different owner. The version is uploaded WHILE the importer still owns the doc
   * so the edit-access check always holds; ownership is transferred afterwards. A
   * lost race on the unique document number surfaces as a `duplicate` outcome.
   */
  private async createDocumentWithOptionalFile(
    dto: CreateDocumentDto,
    file: UploadedFile | undefined,
    ownerId: string,
    user: AuthUser,
    ctx: RequestContext,
  ): Promise<RowOutcome> {
    let documentId: string;
    try {
      const doc = await this.documents.create(dto, user, ctx);
      documentId = doc.id;
    } catch (err) {
      if (err instanceof ConflictException) {
        return {
          status: 'duplicate',
          documentId: null,
          message: 'Skipped: a document with this document number already exists.',
        };
      }
      throw err;
    }

    if (file) {
      await this.documents.addVersion(documentId, file, { changeSummary: 'Imported' }, user, ctx);
    }
    if (ownerId !== user.id) {
      await this.prisma.document.update({ where: { id: documentId }, data: { ownerId } });
    }

    return {
      status: 'created',
      documentId,
      message: file
        ? `Created with version 1 from "${file.originalname}".`
        : 'Created (metadata only — no file was referenced).',
    };
  }

  // ---- Resolution helpers --------------------------------------------------

  /**
   * Runs the three duplicate lookups (scoped to non-deleted documents) and applies
   * the pure {@link findDuplicate} precedence. Only the lookups that make sense for
   * the candidate are issued.
   */
  private async detectDuplicate(candidate: {
    documentNumber?: string;
    checksum?: string;
    title: string;
    fileName?: string;
  }): Promise<DedupeResult | null> {
    const [byDocumentNumber, byChecksum, byTitleFileName] = await Promise.all([
      candidate.documentNumber
        ? this.prisma.document.findFirst({
            where: { deletedAt: null, documentNumber: candidate.documentNumber },
            select: { id: true },
          })
        : Promise.resolve(null),
      candidate.checksum
        ? this.prisma.documentVersion.findFirst({
            where: { checksum: candidate.checksum, document: { deletedAt: null } },
            select: { documentId: true },
          })
        : Promise.resolve(null),
      candidate.fileName
        ? this.prisma.document.findFirst({
            where: {
              deletedAt: null,
              title: candidate.title,
              versions: { some: { fileName: candidate.fileName } },
            },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);
    return findDuplicate({ byDocumentNumber, byChecksum, byTitleFileName });
  }

  /**
   * Resolves (find-or-create) a `/`-separated category path to a leaf category id,
   * reusing existing categories at each level so re-imports never create duplicates.
   * A per-batch cache keyed by the running path avoids redundant lookups/creates.
   */
  private async resolveCategoryPath(
    path: string,
    cache: Map<string, string | null>,
  ): Promise<string | null> {
    const segments = splitCategoryPath(path);
    if (segments.length === 0) return null;

    let parentId: string | null = null;
    let runningPath = '';
    for (const name of segments) {
      runningPath = runningPath ? `${runningPath}/${name}` : name;
      const cached = cache.get(runningPath);
      if (cached !== undefined) {
        parentId = cached;
        continue;
      }
      const existing = await this.prisma.documentCategory.findFirst({
        where: { name, parentId },
        select: { id: true },
      });
      const category =
        existing ??
        (await this.prisma.documentCategory.create({
          data: { name, parentId },
          select: { id: true },
        }));
      cache.set(runningPath, category.id);
      parentId = category.id;
    }
    return parentId;
  }

  /** Resolves an owner email (case-insensitive) to a user id; defaults to importer. */
  private async resolveOwnerId(email: string | undefined, importer: AuthUser): Promise<string> {
    if (!email) return importer.id;
    const owner = await this.prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { id: true },
    });
    return owner?.id ?? importer.id;
  }

  // ---- Persistence helpers -------------------------------------------------

  private async recordItem(batchId: string, data: ItemData): Promise<void> {
    await this.prisma.importItem.create({ data: { batchId, ...data } });
  }

  /** Rolls the counters onto the batch, marks it completed, and audits the run. */
  private async finalize(
    batchId: string,
    counters: Counters,
    user: AuthUser,
    ctx: RequestContext,
    kind: 'manifest' | 'bulk',
  ): Promise<ImportBatchDetail> {
    await this.prisma.importBatch.update({
      where: { id: batchId },
      data: {
        createdCount: counters.created,
        duplicateCount: counters.duplicate,
        errorCount: counters.error,
        status: 'completed',
        completedAt: new Date(),
      },
    });
    await this.audit.record({
      action: AUDIT_ACTIONS.IMPORT_COMPLETED,
      actorUserId: user.id,
      targetType: 'import_batch',
      ...ctx,
      metadata: {
        batchId,
        kind,
        created: counters.created,
        duplicate: counters.duplicate,
        error: counters.error,
      },
    });
    return this.getBatch(batchId);
  }
}

/**
 * Indexes uploaded files by name for row matching. The first occurrence of a name
 * wins (a manifest references a name once); later duplicates are ignored.
 */
function indexFiles(files: UploadedFile[]): Map<string, UploadedFile> {
  const map = new Map<string, UploadedFile>();
  for (const file of files ?? []) {
    if (!map.has(file.originalname)) map.set(file.originalname, file);
  }
  return map;
}

/** Extracts a safe, human-readable message from a thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Unexpected error while importing row.';
}

/** DB batch row (with creator) → API summary. */
function toSummary(row: {
  id: string;
  fileName: string | null;
  totalRows: number;
  createdCount: number;
  duplicateCount: number;
  errorCount: number;
  status: string;
  createdById: string;
  createdAt: Date;
  completedAt: Date | null;
  createdBy: { name: string } | null;
}): ImportBatchSummary {
  return {
    id: row.id,
    fileName: row.fileName,
    totalRows: row.totalRows,
    createdCount: row.createdCount,
    duplicateCount: row.duplicateCount,
    errorCount: row.errorCount,
    status: row.status as ImportBatchStatus,
    createdById: row.createdById,
    createdByName: row.createdBy?.name ?? null,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}

/** DB item row → API report line. */
function toItemResult(row: {
  id: string;
  rowNumber: number;
  title: string | null;
  documentNumber: string | null;
  categoryName: string | null;
  fileName: string | null;
  status: string;
  documentId: string | null;
  message: string | null;
}): ImportItemResult {
  return {
    id: row.id,
    rowNumber: row.rowNumber,
    title: row.title,
    documentNumber: row.documentNumber,
    categoryName: row.categoryName,
    fileName: row.fileName,
    status: row.status as ImportItemStatus,
    documentId: row.documentId,
    message: row.message,
  };
}
