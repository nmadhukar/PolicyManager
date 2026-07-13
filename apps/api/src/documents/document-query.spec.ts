import { buildDocumentListQuery } from './document-query';

describe('buildDocumentListQuery', () => {
  it('defaults to page 1, pageSize 20, newest-first, excluding deleted + archived', () => {
    const q = buildDocumentListQuery({});
    expect(q.page).toBe(1);
    expect(q.pageSize).toBe(20);
    expect(q.skip).toBe(0);
    expect(q.take).toBe(20);
    expect(q.orderBy).toEqual({ createdAt: 'desc' });
    // Soft-deleted rows are never in the default view; archived rows are hidden
    // from active lists but remain accessible via filters (AGENTS.md §9).
    expect(q.where).toEqual({ deletedAt: null, status: { not: 'archived' } });
  });

  it('clamps pageSize to the 1..100 range and page to >= 1', () => {
    expect(buildDocumentListQuery({ pageSize: 500 }).take).toBe(100);
    expect(buildDocumentListQuery({ pageSize: 0 }).take).toBe(1);
    expect(buildDocumentListQuery({ page: 0 }).page).toBe(1);
    expect(buildDocumentListQuery({ page: -3 }).page).toBe(1);
  });

  it('computes skip from page/pageSize', () => {
    const q = buildDocumentListQuery({ page: 3, pageSize: 10 });
    expect(q.skip).toBe(20);
    expect(q.take).toBe(10);
  });

  it('exposes the trimmed term for full-text ranking, NOT as an ILIKE where clause', () => {
    const q = buildDocumentListQuery({ q: '  seclusion  ' });
    // The term is resolved against the tsvector index by the service (ranked), so it
    // must not appear as a substring filter in the Prisma where.
    expect(q.term).toBe('seclusion');
    expect(q.where.AND).toBeUndefined();
    expect(q.where.currentVersion).toBeUndefined();
  });

  it('ignores a blank/whitespace-only search term', () => {
    const q = buildDocumentListQuery({ q: '   ' });
    expect(q.term).toBeUndefined();
    expect(q.where).toEqual({ deletedAt: null, status: { not: 'archived' } });
  });

  it('filters by the current version extraction status', () => {
    const q = buildDocumentListQuery({ extractionStatus: 'failed' });
    expect(q.where.currentVersion).toEqual({ is: { extractionStatus: 'failed' } });
  });

  it('applies scalar filters directly', () => {
    const q = buildDocumentListQuery({
      categoryId: 'cat-1',
      ownerId: 'user-9',
      status: 'published',
      accessLevel: 'confidential',
    });
    expect(q.where.categoryId).toBe('cat-1');
    expect(q.where.ownerId).toBe('user-9');
    // An explicit status filter wins over the default archived-exclusion.
    expect(q.where.status).toBe('published');
    expect(q.where.accessLevel).toBe('confidential');
  });

  describe('soft-delete + archive scoping', () => {
    it('excludes soft-deleted and archived from the default (active) view', () => {
      const q = buildDocumentListQuery({});
      expect(q.where.deletedAt).toBeNull();
      expect(q.where.status).toEqual({ not: 'archived' });
    });

    it('trash view (deleted=true) returns ONLY soft-deleted, without hiding archived', () => {
      const q = buildDocumentListQuery({ deleted: true });
      expect(q.where.deletedAt).toEqual({ not: null });
      // No archived-exclusion in the trash — a deleted+archived doc must show.
      expect(q.where.status).toBeUndefined();
    });

    it('trash view still honors an explicit status filter', () => {
      const q = buildDocumentListQuery({ deleted: true, status: 'archived' });
      expect(q.where.deletedAt).toEqual({ not: null });
      expect(q.where.status).toBe('archived');
    });

    it('includeArchived=true keeps archived in the active view', () => {
      const q = buildDocumentListQuery({ includeArchived: true });
      expect(q.where.deletedAt).toBeNull();
      expect(q.where.status).toBeUndefined();
    });

    it('status=archived surfaces archived documents (still not deleted)', () => {
      const q = buildDocumentListQuery({ status: 'archived' });
      expect(q.where.deletedAt).toBeNull();
      expect(q.where.status).toBe('archived');
    });
  });

  it('filters by a single tag using has', () => {
    expect(buildDocumentListQuery({ tag: 'CARF' }).where.tags).toEqual({ has: 'CARF' });
  });

  it('builds a nextReviewDate range from reviewAfter/reviewBefore', () => {
    const q = buildDocumentListQuery({
      reviewAfter: '2026-01-01',
      reviewBefore: '2026-12-31',
    });
    expect(q.where.nextReviewDate).toEqual({
      gte: new Date('2026-01-01'),
      lte: new Date('2026-12-31'),
    });
  });

  it('ignores unparseable review dates', () => {
    expect(buildDocumentListQuery({ reviewBefore: 'not-a-date' }).where.nextReviewDate).toBeUndefined();
  });

  it('sorts by an allowed field + order', () => {
    expect(buildDocumentListQuery({ sort: 'title', order: 'asc' }).orderBy).toEqual({ title: 'asc' });
    expect(buildDocumentListQuery({ sort: 'nextReviewDate', order: 'desc' }).orderBy).toEqual({
      nextReviewDate: 'desc',
    });
  });

  it('rejects an unknown sort field and falls back to createdAt desc', () => {
    // Guards against SQL-ish injection via the sort param.
    expect(buildDocumentListQuery({ sort: 'password' as never }).orderBy).toEqual({
      createdAt: 'desc',
    });
  });
});
