import type { Prisma } from '@prisma/client';
import {
  DOCUMENT_SORT_FIELDS,
  DEFAULT_REVIEW_LEAD_DAYS,
  type DocumentDueState,
  type DocumentSortField,
  type ExtractionStatus,
  type SortOrder,
} from '@policymanager/shared';

/** Raw (already type-coerced) query inputs for the document list endpoint. */
export interface ListDocumentsQuery {
  q?: string;
  categoryId?: string;
  ownerId?: string;
  tag?: string;
  /** Comma-separated tags; all listed tags must be present. */
  tags?: string;
  status?: string;
  accessLevel?: string;
  /** Filter to documents whose CURRENT version has this extraction status. */
  extractionStatus?: ExtractionStatus;
  reviewBefore?: string;
  reviewAfter?: string;
  effectiveBefore?: string;
  effectiveAfter?: string;
  dueState?: DocumentDueState;
  /**
   * Trash view. When true, return ONLY soft-deleted documents; when false/absent,
   * soft-deleted documents are excluded. RBAC for this view is enforced in the
   * controller (requires `document.write`), not here.
   */
  deleted?: boolean;
  /** When true, archived documents are included in the active view. */
  includeArchived?: boolean;
  page?: number;
  pageSize?: number;
  sort?: DocumentSortField;
  order?: SortOrder;
}

export interface BuiltDocumentQuery {
  where: Prisma.DocumentWhereInput;
  orderBy: Prisma.DocumentOrderByWithRelationInput;
  skip: number;
  take: number;
  page: number;
  pageSize: number;
  /**
   * The trimmed free-text term, if any. Matching/ranking is NOT expressed in
   * `where` (Prisma cannot rank by `ts_rank`); the service resolves it against the
   * full-text `searchVector` (GIN) and orders results by relevance.
   */
  term?: string;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Parses a date string, returning undefined for missing/invalid input. */
function parseDate(value?: string): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * Pure translation of validated list inputs into Prisma `findMany` arguments.
 *
 * Kept side-effect free so filter/sort/pagination logic is unit-testable without
 * a database. The sort field is whitelisted (never interpolated) to prevent
 * ordering by arbitrary/sensitive columns.
 */
export function buildDocumentListQuery(
  query: ListDocumentsQuery,
  now: Date = new Date(),
): BuiltDocumentQuery {
  const page = Math.max(Math.trunc(query.page ?? 1), 1);
  const pageSize = clamp(Math.trunc(query.pageSize ?? DEFAULT_PAGE_SIZE), 1, MAX_PAGE_SIZE);

  const where: Prisma.DocumentWhereInput = {};

  // The term is resolved by the service against the full-text index (ranked); it is
  // deliberately NOT added to `where` here (no ILIKE substring scan on the large
  // extractedText column, and Prisma cannot order by ts_rank).
  const term = query.q?.trim() || undefined;

  if (query.categoryId) where.categoryId = query.categoryId;
  if (query.ownerId) where.ownerId = query.ownerId;
  const tags = splitTags(query.tags);
  if (tags.length > 0) where.tags = { hasEvery: tags };
  else if (query.tag) where.tags = { has: query.tag };
  if (query.accessLevel) {
    where.accessLevel = query.accessLevel as Prisma.DocumentWhereInput['accessLevel'];
  }
  if (query.extractionStatus) {
    // A document's searchability is a property of its CURRENT version's extraction.
    where.currentVersion = { is: { extractionStatus: query.extractionStatus } };
  }

  // Soft-delete + archive scoping (AGENTS.md §9). Documents are never hard-deleted;
  // `deletedAt` gates visibility. Archived documents stay accessible but are kept
  // out of active lists unless explicitly requested.
  const explicitStatus = query.status
    ? (query.status as Prisma.DocumentWhereInput['status'])
    : undefined;
  if (query.deleted) {
    // Trash view: only soft-deleted rows. Do NOT auto-hide archived here — the
    // trash must surface everything that was deleted, archived or not.
    where.deletedAt = { not: null };
    if (explicitStatus) where.status = explicitStatus;
  } else {
    where.deletedAt = null;
    if (explicitStatus) {
      where.status = explicitStatus; // explicit filter wins (may be 'archived')
    } else if (!query.includeArchived) {
      where.status = { not: 'archived' };
    }
  }

  const after = parseDate(query.reviewAfter);
  const before = parseDate(query.reviewBefore);
  if (after || before) {
    where.nextReviewDate = {
      ...(after ? { gte: after } : {}),
      ...(before ? { lte: before } : {}),
    };
  }

  const effectiveAfter = parseDate(query.effectiveAfter);
  const effectiveBefore = parseDate(query.effectiveBefore);
  if (effectiveAfter || effectiveBefore) {
    where.effectiveDate = {
      ...(effectiveAfter ? { gte: effectiveAfter } : {}),
      ...(effectiveBefore ? { lte: effectiveBefore } : {}),
    };
  }

  applyDueState(where, query.dueState, now);

  const sortField: DocumentSortField = DOCUMENT_SORT_FIELDS.includes(query.sort as DocumentSortField)
    ? (query.sort as DocumentSortField)
    : 'createdAt';
  const order: SortOrder = query.order === 'asc' ? 'asc' : 'desc';
  const orderBy: Prisma.DocumentOrderByWithRelationInput = { [sortField]: order };

  return {
    where,
    orderBy,
    skip: (page - 1) * pageSize,
    take: pageSize,
    page,
    pageSize,
    term,
  };
}

/** Splits the advanced-search tags parameter while preserving the legacy `tag`. */
function splitTags(value?: string): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

/**
 * Applies compliance quick filters. These are intentionally server-side so saved
 * searches and UI chips cannot bypass the same ACL-filtered document query path.
 */
function applyDueState(
  where: Prisma.DocumentWhereInput,
  dueState: DocumentDueState | undefined,
  now: Date,
): void {
  if (!dueState) return;
  if (dueState === 'expired') {
    where.nextReviewDate = { not: null, lt: now };
    return;
  }
  if (dueState === 'dueSoon') {
    where.nextReviewDate = {
      not: null,
      gte: now,
      lte: addDays(now, DEFAULT_REVIEW_LEAD_DAYS),
    };
    return;
  }
  if (dueState === 'missingApproval') {
    where.status = { in: ['draft', 'in_review'] };
    return;
  }
  if (dueState === 'notAcknowledged') {
    where.acknowledgmentAssignments = {
      some: { status: { in: ['pending', 'overdue'] } },
    };
  }
}

function addDays(value: Date, days: number): Date {
  const d = new Date(value);
  d.setDate(d.getDate() + days);
  return d;
}
