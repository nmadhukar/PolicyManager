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
  /** When true, the UI must force a password change before any other action. */
  mustChangePassword: boolean;
}

/**
 * Password policy shared by the API (authoritative enforcement) and the web UI
 * (inline hints). Keeping the rule set in one place avoids drift between the two.
 */
export const PASSWORD_MIN_LENGTH = 8;

/** Trivially weak passwords rejected regardless of length. */
const TRIVIAL_PASSWORDS = new Set([
  'password',
  'password1',
  'passw0rd',
  '12345678',
  '123456789',
  'qwertyui',
  'iloveyou',
  'changeme',
  'letmein1',
  'admin123',
]);

/**
 * Returns a list of human-readable policy violations for `password`.
 * An empty array means the password is acceptable. Pure + deterministic so it is
 * unit-testable and can run identically on the server and (for hints) the client.
 */
export function validatePassword(password: string): string[] {
  const errors: string[] = [];
  const pw = password ?? '';
  if (pw.length < PASSWORD_MIN_LENGTH) {
    errors.push(`Use at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
  if (pw.length > 200) {
    errors.push('Use no more than 200 characters.');
  }
  if (/^(.)\1*$/.test(pw) && pw.length > 0) {
    errors.push('Do not use a single repeated character.');
  }
  if (TRIVIAL_PASSWORDS.has(pw.toLowerCase())) {
    errors.push('This password is too common. Choose something less guessable.');
  }
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) {
    errors.push('Include at least one letter and one number.');
  }
  return errors;
}

/** Static, display-ready policy hints for the UI. */
export const PASSWORD_POLICY_HINTS: readonly string[] = [
  `At least ${PASSWORD_MIN_LENGTH} characters`,
  'At least one letter and one number',
  'Not a common or trivial password',
] as const;

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
