import { buildDocumentListQuery } from './document-query';

describe('buildDocumentListQuery', () => {
  it('defaults to page 1, pageSize 20, newest-first', () => {
    const q = buildDocumentListQuery({});
    expect(q.page).toBe(1);
    expect(q.pageSize).toBe(20);
    expect(q.skip).toBe(0);
    expect(q.take).toBe(20);
    expect(q.orderBy).toEqual({ createdAt: 'desc' });
    expect(q.where).toEqual({});
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

  it('builds a case-insensitive OR search across title/number/description', () => {
    const q = buildDocumentListQuery({ q: 'seclusion' });
    expect(q.where.AND).toEqual([
      {
        OR: [
          { title: { contains: 'seclusion', mode: 'insensitive' } },
          { documentNumber: { contains: 'seclusion', mode: 'insensitive' } },
          { description: { contains: 'seclusion', mode: 'insensitive' } },
        ],
      },
    ]);
  });

  it('ignores a blank/whitespace-only search term', () => {
    expect(buildDocumentListQuery({ q: '   ' }).where).toEqual({});
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
    expect(q.where.status).toBe('published');
    expect(q.where.accessLevel).toBe('confidential');
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
