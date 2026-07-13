import { buildPublicVisibilityWhere } from './public-document-query';

/**
 * The visibility builder is the public API's data-leak boundary (AGENTS.md §8).
 * These assert the floor is ALWAYS applied and that a client can never widen its
 * own category scope through a filter.
 */
describe('public-document-query', () => {
  const allAccess = { allowedCategoryIds: [] as string[] };

  describe('buildPublicVisibilityWhere', () => {
    it('always applies the published + non-deleted + non-confidential floor', () => {
      const where = buildPublicVisibilityWhere(allAccess);
      expect(where.status).toBe('published');
      expect(where.deletedAt).toBeNull();
      expect(where.accessLevel).toEqual({ not: 'confidential' });
      // With no allow-list and no filters, there are no extra AND constraints.
      expect(where.AND).toBeUndefined();
    });

    it('restricts to the client allow-list when non-empty', () => {
      const where = buildPublicVisibilityWhere({ allowedCategoryIds: ['cat-a', 'cat-b'] });
      expect(where.AND).toEqual([{ categoryId: { in: ['cat-a', 'cat-b'] } }]);
      // Floor still present.
      expect(where.status).toBe('published');
    });

    it('AND-combines a requested category with the allow-list (cannot widen scope)', () => {
      // Requesting a category OUTSIDE the allow-list keeps BOTH clauses, so the
      // query resolves to zero rows rather than leaking the foreign category.
      const where = buildPublicVisibilityWhere(
        { allowedCategoryIds: ['cat-a'] },
        { categoryId: 'cat-forbidden' },
      );
      expect(where.AND).toEqual([
        { categoryId: { in: ['cat-a'] } },
        { categoryId: 'cat-forbidden' },
      ]);
    });

    it('adds tag, q, and updatedSince filters', () => {
      const where = buildPublicVisibilityWhere(allAccess, {
        tag: 'CARF',
        q: 'seclusion',
        updatedSince: '2026-01-01T00:00:00.000Z',
      });
      const and = where.AND as unknown[];
      expect(and).toContainEqual({ tags: { has: 'CARF' } });
      expect(and).toContainEqual({
        OR: [
          { title: { contains: 'seclusion', mode: 'insensitive' } },
          { documentNumber: { contains: 'seclusion', mode: 'insensitive' } },
          { description: { contains: 'seclusion', mode: 'insensitive' } },
        ],
      });
      expect(and).toContainEqual({ updatedAt: { gte: new Date('2026-01-01T00:00:00.000Z') } });
    });

    it('ignores an invalid updatedSince', () => {
      const where = buildPublicVisibilityWhere(allAccess, { updatedSince: 'not-a-date' });
      expect(where.AND).toBeUndefined();
    });
  });
});
