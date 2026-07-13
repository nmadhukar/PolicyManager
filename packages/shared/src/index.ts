// Shared types & constants across api and web.

export const PERMISSIONS = {
  DOCUMENT_READ: 'document.read',
  DOCUMENT_WRITE: 'document.write',
  DOCUMENT_APPROVE: 'document.approve',
  REVIEW_MANAGE: 'review.manage',
  USER_MANAGE: 'user.manage',
  STORAGE_MANAGE: 'storage.manage',
  SMTP_MANAGE: 'smtp.manage',
  API_MANAGE: 'api.manage',
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ROLES = {
  ADMIN: 'Admin',
  COMPLIANCE_OFFICER: 'Compliance Officer',
  MANAGER: 'Manager',
  STAFF: 'Staff',
  AUDITOR: 'Auditor',
} as const;

export type RoleName = (typeof ROLES)[keyof typeof ROLES];

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  roles: string[];
  permissions: string[];
}

export type AccessLevel = 'public' | 'restricted' | 'confidential';
export type DocumentStatus =
  | 'draft'
  | 'in_review'
  | 'approved'
  | 'published'
  | 'archived'
  | 'retired';
export type ReviewCadence = 'none' | 'quarterly' | 'annual' | 'custom';

// Enumerations as ordered arrays for validation (API) and dropdowns (UI).
export const DOCUMENT_STATUSES: readonly DocumentStatus[] = [
  'draft',
  'in_review',
  'approved',
  'published',
  'archived',
  'retired',
] as const;

export const ACCESS_LEVELS: readonly AccessLevel[] = [
  'public',
  'restricted',
  'confidential',
] as const;

export const REVIEW_CADENCES: readonly ReviewCadence[] = [
  'none',
  'quarterly',
  'annual',
  'custom',
] as const;

export const DOCUMENT_SORT_FIELDS = ['title', 'createdAt', 'nextReviewDate', 'status'] as const;
export type DocumentSortField = (typeof DOCUMENT_SORT_FIELDS)[number];
export type SortOrder = 'asc' | 'desc';

/** Generic paginated envelope returned by list endpoints. */
export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** Summary of one immutable file version (metadata only — never the bytes). */
export interface DocumentVersionSummary {
  id: string;
  versionNumber: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  changeSummary: string | null;
  status: DocumentStatus;
  createdAt: string;
  uploadedByName: string | null;
  /** Whether text was extracted for search/RAG (the text itself is scope-gated). */
  hasExtractedText: boolean;
}

/** Row shape for the document library list. */
export interface DocumentListItem {
  id: string;
  title: string;
  documentNumber: string | null;
  categoryId: string | null;
  categoryName: string | null;
  ownerId: string;
  ownerName: string | null;
  status: DocumentStatus;
  accessLevel: AccessLevel;
  tags: string[];
  reviewCadence: ReviewCadence;
  nextReviewDate: string | null;
  effectiveDate: string | null;
  createdAt: string;
  updatedAt: string;
  currentVersion: DocumentVersionSummary | null;
}

/** Full document detail including description and the complete version history. */
export interface DocumentDetail extends DocumentListItem {
  description: string | null;
  versions: DocumentVersionSummary[];
}

/** Node in the document-category tree. */
export interface DocumentCategoryNode {
  id: string;
  name: string;
  parentId: string | null;
  description: string | null;
  children: DocumentCategoryNode[];
}
