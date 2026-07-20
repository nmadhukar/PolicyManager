/** Library scope: active (default), archived-only, or the soft-delete trash. */
export type LibraryView = 'active' | 'archived' | 'trash';

export interface Filters {
  q: string;
  categoryId: string;
  ownerId: string;
  tag: string;
  tags: string;
  status: string;
  accessLevel: string;
  extractionStatus: string;
  reviewAfter: string;
  reviewBefore: string;
  effectiveAfter: string;
  effectiveBefore: string;
  dueState: string;
}

export const EMPTY_FILTERS: Filters = {
  q: '',
  categoryId: '',
  ownerId: '',
  tag: '',
  tags: '',
  status: '',
  accessLevel: '',
  extractionStatus: '',
  reviewAfter: '',
  reviewBefore: '',
  effectiveAfter: '',
  effectiveBefore: '',
  dueState: '',
};

export const PAGE_SIZE = 20;
// FINDING-002: cap on the owner-filter fallback cache (non-admins, no full user
// directory) so paging through a large library can't grow it without bound.
export const OWNER_OPTIONS_CAP = 500;
