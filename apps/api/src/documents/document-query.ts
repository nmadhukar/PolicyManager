import type { Prisma } from '@prisma/client';
import {
  DOCUMENT_SORT_FIELDS,
  type DocumentSortField,
  type SortOrder,
} from '@policymanager/shared';

/** Raw (already type-coerced) query inputs for the document list endpoint. */
export interface ListDocumentsQuery {
  q?: string;
  categoryId?: string;
  ownerId?: string;
  tag?: string;
  status?: string;
  accessLevel?: string;
  reviewBefore?: string;
  reviewAfter?: string;
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
export function buildDocumentListQuery(query: ListDocumentsQuery): BuiltDocumentQuery {
  const page = Math.max(Math.trunc(query.page ?? 1), 1);
  const pageSize = clamp(Math.trunc(query.pageSize ?? DEFAULT_PAGE_SIZE), 1, MAX_PAGE_SIZE);

  const where: Prisma.DocumentWhereInput = {};

  const term = query.q?.trim();
  if (term) {
    where.AND = [
      {
        OR: [
          { title: { contains: term, mode: 'insensitive' } },
          { documentNumber: { contains: term, mode: 'insensitive' } },
          { description: { contains: term, mode: 'insensitive' } },
        ],
      },
    ];
  }

  if (query.categoryId) where.categoryId = query.categoryId;
  if (query.ownerId) where.ownerId = query.ownerId;
  if (query.tag) where.tags = { has: query.tag };
  if (query.accessLevel) {
    where.accessLevel = query.accessLevel as Prisma.DocumentWhereInput['accessLevel'];
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
  };
}
