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
  /** Read the immutable audit trail (Admin, Compliance Officer, Auditor). */
  AUDIT_READ: 'audit.read',
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
  /**
   * Whether a uniform PDF rendition exists for in-browser viewing. True when a
   * rendition was generated (Office/HTML) OR the source is itself viewable
   * (PDF/image). False means the original is download-only for now.
   */
  hasRendition: boolean;
}

/**
 * Short-lived, presigned URL for in-browser VIEWING of a version (the PDF
 * rendition, the source PDF, or a source image). Never the raw office bytes.
 */
export interface ViewTicket {
  url: string;
  expiresIn: number;
  /** `application/pdf` for renditions/PDFs, or the image mime for images. */
  mimeType: string;
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
  /** Non-null when the document is soft-deleted (in the trash); null otherwise. */
  deletedAt: string | null;
  /** Display name of the user who soft-deleted the document, when applicable. */
  deletedByName: string | null;
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

// ---------------------------------------------------------------------------
// Storage Admin (Phase 3b, PM-0313). All operations are gated by storage.manage
// and are NON-destructive in v1 (create/list only — no delete surface).
// ---------------------------------------------------------------------------

/** A bucket as surfaced to the Storage Admin UI. */
export interface StorageBucket {
  name: string;
  createdAt: string | null;
  /** True for the app's configured default document bucket. */
  isDefault: boolean;
}

/** A top-level "folder" (common prefix) within a bucket. */
export interface StoragePrefix {
  prefix: string;
}

/** Read-only view of the effective storage configuration. */
export interface StorageConfigView {
  bucket: string;
  prefixes: {
    documents: string;
    renditions: string;
  };
  endpoint: string | null;
  region: string;
}

// ---------------------------------------------------------------------------
// Access Control & Audit (Phase 4, PM-0401..PM-0407)
// ---------------------------------------------------------------------------

/** Whether an ACL grant targets a role (all its members) or a single user. */
export type AclPrincipalType = 'role' | 'user';
export const ACL_PRINCIPAL_TYPES: readonly AclPrincipalType[] = ['role', 'user'] as const;

/** The capability an ACL grant confers. */
export type AclPermission = 'view' | 'download' | 'edit' | 'approve';
export const ACL_PERMISSIONS: readonly AclPermission[] = [
  'view',
  'download',
  'edit',
  'approve',
] as const;

/** The action a caller is attempting against a document, for authorization. */
export type AccessAction = 'view' | 'download' | 'edit' | 'approve';

/**
 * One access-control grant on a document (or a category, cascading to its docs).
 * `principalId` is a roleId when `principalType='role'`, else a userId;
 * `principalName` is the resolved display name for the UI.
 */
export interface AclGrant {
  id: string;
  documentId: string | null;
  categoryId: string | null;
  principalType: AclPrincipalType;
  principalId: string;
  principalName: string | null;
  permission: AclPermission;
  createdAt: string;
  createdByName: string | null;
}

/** Where an audited action originated. */
export type AuditSource = 'web' | 'api' | 'system';
export const AUDIT_SOURCES: readonly AuditSource[] = ['web', 'api', 'system'] as const;

/**
 * Canonical audit action strings, shared by the API (authoritative writer) and
 * the web (filter dropdown + labels) so the two never drift.
 */
export const AUDIT_ACTIONS = {
  DOCUMENT_CREATED: 'document.created',
  DOCUMENT_UPDATED: 'document.updated',
  DOCUMENT_VIEWED: 'document.viewed',
  DOCUMENT_DOWNLOADED: 'document.downloaded',
  DOCUMENT_DELETED: 'document.deleted',
  DOCUMENT_RESTORED: 'document.restored',
  DOCUMENT_ARCHIVED: 'document.archived',
  DOCUMENT_UNARCHIVED: 'document.unarchived',
  DOCUMENT_EDITED: 'document.edited',
  VERSION_UPLOADED: 'version.uploaded',
  VERSION_RESTORED: 'version.restored',
  ACL_CHANGED: 'acl.changed',
  ACCESS_DENIED: 'access.denied',
  USER_LOGIN: 'user.login',
  USER_LOGIN_FAILED: 'user.login_failed',
  USER_PASSWORD_RESET: 'user.password_reset',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
export const AUDIT_ACTION_VALUES: readonly string[] = Object.values(AUDIT_ACTIONS);

/** Human labels for audit actions (UI display; falls back to the raw key). */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  [AUDIT_ACTIONS.DOCUMENT_CREATED]: 'Document created',
  [AUDIT_ACTIONS.DOCUMENT_UPDATED]: 'Document updated',
  [AUDIT_ACTIONS.DOCUMENT_VIEWED]: 'Document viewed',
  [AUDIT_ACTIONS.DOCUMENT_DOWNLOADED]: 'Document downloaded',
  [AUDIT_ACTIONS.DOCUMENT_DELETED]: 'Document deleted',
  [AUDIT_ACTIONS.DOCUMENT_RESTORED]: 'Document restored',
  [AUDIT_ACTIONS.DOCUMENT_ARCHIVED]: 'Document archived',
  [AUDIT_ACTIONS.DOCUMENT_UNARCHIVED]: 'Document unarchived',
  [AUDIT_ACTIONS.DOCUMENT_EDITED]: 'Document edited',
  [AUDIT_ACTIONS.VERSION_UPLOADED]: 'Version uploaded',
  [AUDIT_ACTIONS.VERSION_RESTORED]: 'Version restored',
  [AUDIT_ACTIONS.ACL_CHANGED]: 'Access changed',
  [AUDIT_ACTIONS.ACCESS_DENIED]: 'Access denied',
  [AUDIT_ACTIONS.USER_LOGIN]: 'Sign-in',
  [AUDIT_ACTIONS.USER_LOGIN_FAILED]: 'Failed sign-in',
  [AUDIT_ACTIONS.USER_PASSWORD_RESET]: 'Password reset',
};

/** One row of the audit trail as surfaced to the audit query API + UI. */
export interface AuditEventItem {
  id: string;
  action: string;
  source: AuditSource;
  targetType: string | null;
  documentId: string | null;
  documentTitle: string | null;
  documentNumber: string | null;
  versionId: string | null;
  actorUserId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}
