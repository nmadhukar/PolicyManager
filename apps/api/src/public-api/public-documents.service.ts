import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AUDIT_ACTIONS,
  type ApiDocument,
  type ApiDocumentContent,
  type ApiDocumentVersion,
  type ApiDownloadTicket,
  type ApiSearchHit,
  type ApiSearchResponse,
  type Paginated,
} from '@policymanager/shared';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../storage/s3.service';
import { AuditService } from '../audit/audit.service';
import type { RequestContext } from '../audit/request-context';
import type { AuthenticatedApiClient } from '../api-clients/api-client.types';
import {
  buildPublicVisibilityWhere,
  type PublicListFilters,
} from './public-document-query';

/** Presigned download TTL for the public API — short-lived per AGENTS.md §8. */
const DOWNLOAD_TTL_SECONDS = 300;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
/** Characters of extracted text returned on either side of a search match. */
const SNIPPET_RADIUS = 120;

/** Query inputs for the public list endpoint (already coerced by the DTO). */
export interface PublicListQuery extends PublicListFilters {
  page?: number;
  pageSize?: number;
}

/** Document fields projected into the public {@link ApiDocument} shape. */
const apiDocumentSelect = {
  id: true,
  title: true,
  documentNumber: true,
  categoryId: true,
  status: true,
  accessLevel: true,
  tags: true,
  effectiveDate: true,
  updatedAt: true,
  category: { select: { name: true } },
  currentVersion: { select: { versionNumber: true } },
} satisfies Prisma.DocumentSelect;

type ApiDocumentRow = Prisma.DocumentGetPayload<{ select: typeof apiDocumentSelect }>;

interface PublicSearchRow {
  id: string;
  title: string;
  documentNumber: string | null;
  categoryId: string | null;
  categoryName: string | null;
  status: string;
  accessLevel: string;
  tags: string[];
  versionNumber: number | null;
  effectiveDate: Date | null;
  updatedAt: Date;
  extractedText: string | null;
  score: number;
}

/**
 * Read-only data access for the public API (`/api/v1`). EVERY method enforces the
 * public visibility floor (published + non-deleted + non-confidential + within the
 * client's category allow-list) and audits the call with `source=api` +
 * `apiClientId` (AGENTS.md §8). There are NO write paths here.
 */
@Injectable()
export class PublicDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
    private readonly audit: AuditService,
  ) {}

  /** Paginated, filtered list of visible documents. */
  async list(
    client: AuthenticatedApiClient,
    query: PublicListQuery,
    ctx: RequestContext = {},
  ): Promise<Paginated<ApiDocument>> {
    const { page, pageSize, skip, take } = this.paginate(query.page, query.pageSize);
    const where = buildPublicVisibilityWhere(client, query);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.document.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip,
        take,
        select: apiDocumentSelect,
      }),
      this.prisma.document.count({ where }),
    ]);

    await this.audit.record({
      action: AUDIT_ACTIONS.API_DOCUMENTS_LISTED,
      apiClientId: client.id,
      source: 'api',
      targetType: 'document',
      ...ctx,
      metadata: { count: rows.length, total, page },
    });

    return { items: rows.map((r) => this.toApiDocument(r)), total, page, pageSize };
  }

  /** Single visible document (404 when not visible to this client). */
  async get(
    client: AuthenticatedApiClient,
    id: string,
    ctx: RequestContext = {},
  ): Promise<ApiDocument> {
    const row = await this.loadVisible(client, id, apiDocumentSelect);
    await this.audit.record({
      action: AUDIT_ACTIONS.API_DOCUMENT_READ,
      apiClientId: client.id,
      source: 'api',
      documentId: id,
      targetType: 'document',
      ...ctx,
    });
    return this.toApiDocument(row);
  }

  /**
   * Extracted text of the current version (scope `content:read`, enforced by the
   * guard). Returns an empty payload with `hasExtractedText:false` when the visible
   * document has no current version or no extracted text — never leaks bytes.
   */
  async getContent(
    client: AuthenticatedApiClient,
    id: string,
    ctx: RequestContext = {},
  ): Promise<ApiDocumentContent> {
    const doc = await this.loadVisible(client, id, {
      currentVersion: {
        select: { id: true, versionNumber: true, extractedText: true },
      },
    });
    await this.audit.record({
      action: AUDIT_ACTIONS.API_CONTENT_READ,
      apiClientId: client.id,
      source: 'api',
      documentId: id,
      targetType: 'document',
      ...ctx,
    });

    const version = doc.currentVersion;
    const text = version?.extractedText ?? '';
    return {
      documentId: id,
      versionId: version?.id ?? null,
      version: version?.versionNumber ?? null,
      extractedText: text,
      hasExtractedText: text.length > 0,
    };
  }

  /**
   * Short-lived presigned download URL for the current version (scope `download`).
   * The bucket stays private; bytes never stream through the API (AGENTS.md §8).
   * 404 when the visible document has no current version.
   */
  async getDownload(
    client: AuthenticatedApiClient,
    id: string,
    ctx: RequestContext = {},
  ): Promise<ApiDownloadTicket> {
    const doc = await this.loadVisible(client, id, {
      currentVersion: {
        select: { versionNumber: true, s3Key: true, s3VersionId: true, fileName: true },
      },
    });
    const version = doc.currentVersion;
    if (!version) throw new NotFoundException('No downloadable version is available');

    const url = await this.s3.getPresignedDownloadUrl(
      version.s3Key,
      DOWNLOAD_TTL_SECONDS,
      version.fileName,
      version.s3VersionId ?? undefined,
    );
    await this.audit.record({
      action: AUDIT_ACTIONS.API_DOWNLOAD_ISSUED,
      apiClientId: client.id,
      source: 'api',
      documentId: id,
      targetType: 'document',
      ...ctx,
      metadata: { fileName: version.fileName, versionNumber: version.versionNumber },
    });
    return {
      url,
      expiresIn: DOWNLOAD_TTL_SECONDS,
      fileName: version.fileName,
      version: version.versionNumber,
    };
  }

  /** Full, newest-first version history (metadata only) of a visible document. */
  async getVersions(
    client: AuthenticatedApiClient,
    id: string,
    ctx: RequestContext = {},
  ): Promise<ApiDocumentVersion[]> {
    const doc = await this.loadVisible(client, id, {
      versions: {
        orderBy: { versionNumber: 'desc' },
        select: {
          versionNumber: true,
          fileName: true,
          mimeType: true,
          sizeBytes: true,
          checksum: true,
          createdAt: true,
          // D2: read the persisted flag, not the (large) @db.Text column.
          hasExtractedText: true,
        },
      },
    });
    await this.audit.record({
      action: AUDIT_ACTIONS.API_VERSIONS_READ,
      apiClientId: client.id,
      source: 'api',
      documentId: id,
      targetType: 'document',
      ...ctx,
    });
    return doc.versions.map((v) => ({
      version: v.versionNumber,
      fileName: v.fileName,
      mimeType: v.mimeType,
      // D10: BigInt column → JSON-safe number.
      sizeBytes: Number(v.sizeBytes),
      checksum: v.checksum,
      createdAt: v.createdAt.toISOString(),
      hasExtractedText: v.hasExtractedText,
    }));
  }

  /**
   * Keyword search over title + current-version extracted text. The response is
   * shaped for a future semantic (pgvector) backend behind the SAME contract:
   * each hit carries a `score` and a `snippet`. Today the score is a simple
   * title>content heuristic and the snippet is a keyword window.
   */
  async search(
    client: AuthenticatedApiClient,
    q: string,
    page: number | undefined,
    pageSize: number | undefined,
    ctx: RequestContext = {},
  ): Promise<ApiSearchResponse> {
    const term = (q ?? '').trim();
    const paged = this.paginate(page, pageSize);
    if (!term) {
      await this.recordSearch(client, term, 0, ctx);
      return { query: term, total: 0, page: paged.page, pageSize: paged.pageSize, items: [] };
    }

    const searchWhere = publicSearchWhereSql(client, term);
    const rows = await this.prisma.$queryRaw<PublicSearchRow[]>(Prisma.sql`
      SELECT
        d."id",
        d."title",
        d."documentNumber",
        d."categoryId",
        c."name" AS "categoryName",
        d."status"::text AS "status",
        d."accessLevel"::text AS "accessLevel",
        d."tags",
        v."versionNumber",
        d."effectiveDate",
        d."updatedAt",
        v."extractedText",
        ts_rank_cd(${publicSearchVectorSql()}, plainto_tsquery('english', ${term}))::float AS "score"
      FROM "policytracker"."Document" d
      LEFT JOIN "policytracker"."DocumentCategory" c ON c."id" = d."categoryId"
      LEFT JOIN "policytracker"."DocumentVersion" v ON v."id" = d."currentVersionId"
      ${searchWhere}
      ORDER BY "score" DESC, d."updatedAt" DESC
      LIMIT ${paged.take} OFFSET ${paged.skip}
    `);
    const countRows = await this.prisma.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`
      SELECT count(*)::bigint AS "total"
      FROM "policytracker"."Document" d
      LEFT JOIN "policytracker"."DocumentVersion" v ON v."id" = d."currentVersionId"
      ${searchWhere}
    `);
    const total = Number(countRows[0]?.total ?? 0);

    await this.recordSearch(client, term, total, ctx);

    const items: ApiSearchHit[] = rows.map((row) => {
      const titleHit = row.title.toLowerCase().includes(term.toLowerCase());
      const snippet = buildSnippet(row.extractedText, term);
      return {
        document: {
          id: row.id,
          title: row.title,
          documentNumber: row.documentNumber,
          categoryId: row.categoryId,
          categoryName: row.categoryName,
          status: row.status as ApiDocument['status'],
          accessLevel: row.accessLevel as ApiDocument['accessLevel'],
          tags: row.tags,
          version: row.versionNumber,
          effectiveDate: row.effectiveDate ? row.effectiveDate.toISOString() : null,
          updatedAt: row.updatedAt.toISOString(),
        },
        score: Number(row.score) || (titleHit ? 1 : 0.25),
        snippet,
      };
    });

    return { query: term, total, page: paged.page, pageSize: paged.pageSize, items };
  }

  // ---- Helpers -------------------------------------------------------------

  private async recordSearch(
    client: AuthenticatedApiClient,
    term: string,
    total: number,
    ctx: RequestContext,
  ): Promise<void> {
    await this.audit.record({
      action: AUDIT_ACTIONS.API_SEARCH,
      apiClientId: client.id,
      source: 'api',
      targetType: 'document',
      ...ctx,
      metadata: { q: term, total },
    });
  }

  /**
   * Loads a document by id ONLY if it passes this client's public visibility
   * gate, merging the caller-supplied relation `select` with the id projection.
   * 404 (never 403) when not visible — the public API does not disclose the
   * existence of documents outside a client's scope.
   */
  private async loadVisible<S extends Prisma.DocumentSelect>(
    client: AuthenticatedApiClient,
    id: string,
    select: S,
  ): Promise<Prisma.DocumentGetPayload<{ select: S }>> {
    const where: Prisma.DocumentWhereInput = { id, ...buildPublicVisibilityWhere(client) };
    const doc = await this.prisma.document.findFirst({
      where,
      select,
    });
    if (!doc) throw new NotFoundException('Document not found');
    return doc as Prisma.DocumentGetPayload<{ select: S }>;
  }

  private paginate(
    pageInput?: number,
    pageSizeInput?: number,
  ): { page: number; pageSize: number; skip: number; take: number } {
    const page = Math.max(Math.trunc(pageInput ?? 1), 1);
    const pageSize = Math.min(
      Math.max(Math.trunc(pageSizeInput ?? DEFAULT_PAGE_SIZE), 1),
      MAX_PAGE_SIZE,
    );
    return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
  }

  private toApiDocument(row: ApiDocumentRow): ApiDocument {
    return {
      id: row.id,
      title: row.title,
      documentNumber: row.documentNumber,
      categoryId: row.categoryId,
      categoryName: row.category?.name ?? null,
      status: row.status as ApiDocument['status'],
      accessLevel: row.accessLevel as ApiDocument['accessLevel'],
      tags: row.tags,
      version: row.currentVersion?.versionNumber ?? null,
      effectiveDate: row.effectiveDate ? row.effectiveDate.toISOString() : null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

function publicSearchVectorSql(): Prisma.Sql {
  return Prisma.sql`
    setweight(to_tsvector('english', coalesce(d."title", '')), 'A') ||
    setweight(to_tsvector('english', coalesce(d."documentNumber", '')), 'B') ||
    setweight(to_tsvector('english', coalesce(d."description", '')), 'B') ||
    coalesce(v."searchVector", to_tsvector('english', ''))
  `;
}

function publicSearchWhereSql(client: AuthenticatedApiClient, term: string): Prisma.Sql {
  const likeTerm = `%${term}%`;
  const allowList =
    client.allowedCategoryIds.length > 0
      ? Prisma.sql`AND d."categoryId" IN (${Prisma.join(client.allowedCategoryIds)})`
      : Prisma.empty;
  return Prisma.sql`
    WHERE d."status" = 'published'
      AND d."deletedAt" IS NULL
      AND d."accessLevel" <> 'confidential'
      ${allowList}
      AND (
        ${publicSearchVectorSql()} @@ plainto_tsquery('english', ${term})
        OR d."title" ILIKE ${likeTerm}
        OR d."documentNumber" ILIKE ${likeTerm}
        OR d."description" ILIKE ${likeTerm}
      )
  `;
}

/**
 * Extracts a short, human-readable snippet around the first case-insensitive
 * occurrence of `term` in `text`. Returns null when there is no text; falls back
 * to the head of the text when the term is not found (e.g. a title-only match).
 * Pure + exported for unit testing.
 */
export function buildSnippet(text: string | null, term: string): string | null {
  if (!text) return null;
  const idx = text.toLowerCase().indexOf(term.toLowerCase());
  if (idx < 0) {
    const head = text.slice(0, SNIPPET_RADIUS * 2).trim();
    return head.length < text.length ? `${head}…` : head;
  }
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(text.length, idx + term.length + SNIPPET_RADIUS);
  const core = text.slice(start, end).trim();
  return `${start > 0 ? '…' : ''}${core}${end < text.length ? '…' : ''}`;
}
