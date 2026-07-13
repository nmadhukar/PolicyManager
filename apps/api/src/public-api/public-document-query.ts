import type { Prisma } from '@prisma/client';

/** The subset of a client that governs visibility (its category allow-list). */
export interface VisibilityClient {
  allowedCategoryIds: string[];
}

/** Optional filters accepted by the public list endpoint. */
export interface PublicListFilters {
  categoryId?: string;
  tag?: string;
  q?: string;
  /** ISO timestamp; only documents updated at/after this are returned. */
  updatedSince?: string;
}

/**
 * The non-negotiable public visibility floor (AGENTS.md §8 — the public API must
 * never leak anything but published, non-confidential, live documents):
 *   status = published  AND  deletedAt = null  AND  accessLevel != confidential.
 * `status = published` inherently excludes draft/in_review/approved/archived/
 * retired; the explicit `deletedAt = null` additionally hides a soft-deleted
 * (but still 'published') document.
 */
function visibilityFloor(): Prisma.DocumentWhereInput {
  return {
    status: 'published',
    deletedAt: null,
    accessLevel: { not: 'confidential' },
  };
}

/**
 * Constraints that scope the result to the client's category allow-list plus any
 * caller-supplied filters. Returned as an AND-list so a requested `categoryId`
 * that is NOT in the allow-list yields zero rows (the two `categoryId` clauses
 * cannot both be satisfied) — a client can never widen its own scope via a filter.
 */
function scopeAndFilters(
  client: VisibilityClient,
  filters: PublicListFilters,
): Prisma.DocumentWhereInput[] {
  const and: Prisma.DocumentWhereInput[] = [];

  // Empty allow-list = all categories; non-empty restricts to those ids.
  if (client.allowedCategoryIds.length > 0) {
    and.push({ categoryId: { in: client.allowedCategoryIds } });
  }
  if (filters.categoryId) and.push({ categoryId: filters.categoryId });
  if (filters.tag) and.push({ tags: { has: filters.tag } });

  const term = filters.q?.trim();
  if (term) {
    and.push({
      OR: [
        { title: { contains: term, mode: 'insensitive' } },
        { documentNumber: { contains: term, mode: 'insensitive' } },
        { description: { contains: term, mode: 'insensitive' } },
      ],
    });
  }

  const since = filters.updatedSince ? new Date(filters.updatedSince) : undefined;
  if (since && !Number.isNaN(since.getTime())) {
    and.push({ updatedAt: { gte: since } });
  }
  return and;
}

/**
 * Builds the Prisma where-clause for the public document list. Combines the
 * visibility floor with the client's allow-list and caller filters. Pure +
 * side-effect free so the security-critical filter is unit-testable without a DB.
 */
export function buildPublicVisibilityWhere(
  client: VisibilityClient,
  filters: PublicListFilters = {},
): Prisma.DocumentWhereInput {
  const where = visibilityFloor();
  const and = scopeAndFilters(client, filters);
  if (and.length > 0) where.AND = and;
  return where;
}

// Keyword search runs as ranked full-text SQL in `PublicDocumentsService`
// (`publicSearchWhereSql` / `publicSearchVectorSql`), which applies the same
// visibility floor + allow-list. There is no Prisma-builder equivalent by design —
// the floor lives in exactly one place for search.
