// Shared types & constants across api and web.

export const PERMISSIONS = {
  DOCUMENT_READ: 'document.read',
  DOCUMENT_WRITE: 'document.write',
  DOCUMENT_APPROVE: 'document.approve',
  DOCUMENT_COMMENT: 'document.comment',
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
export type ExtractionStatus = 'pending' | 'processing' | 'done' | 'failed' | 'skipped';

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

export const EXTRACTION_STATUSES: readonly ExtractionStatus[] = [
  'pending',
  'processing',
  'done',
  'failed',
  'skipped',
] as const;

export const EXTRACTION_STATUS_LABELS: Record<ExtractionStatus, string> = {
  pending: 'Queued',
  processing: 'Processing',
  done: 'Search ready',
  failed: 'Failed',
  skipped: 'Skipped',
};

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
  /** Async extraction/OCR lifecycle for the version. */
  extractionStatus: ExtractionStatus;
  /** True when OCR was used instead of metadata/text-only extraction. */
  ocrApplied: boolean;
  /** Operator-safe failure/skipped reason; never contains extracted text. */
  extractionError: string | null;
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
  /** Open comments/issues on the current version, used to warn approvers. */
  unresolvedAnnotationCount: number;
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
  EXTRACTION_REINDEXED: 'extraction.reindexed',
  EXTRACTION_PROCESSED: 'extraction.processed',
  ACL_CHANGED: 'acl.changed',
  ACCESS_DENIED: 'access.denied',
  USER_LOGIN: 'user.login',
  USER_LOGIN_FAILED: 'user.login_failed',
  USER_PASSWORD_RESET: 'user.password_reset',
  // Phase 5 — QC review scheduling + SMTP admin.
  REVIEW_ASSIGNED: 'review.assigned',
  REVIEW_TASK_CREATED: 'review.task_created',
  REVIEW_COMPLETED: 'review.completed',
  SMTP_CONFIG_CHANGED: 'smtp.config_changed',
  SMTP_TEST_SENT: 'smtp.test_sent',
  // Phase 6 — Attestation (sign-off), approval, and acknowledgment distribution.
  ATTESTATION_REVIEWED: 'attestation.reviewed',
  ATTESTATION_APPROVED: 'attestation.approved',
  ATTESTATION_ACKNOWLEDGED: 'attestation.acknowledged',
  DOCUMENT_APPROVED: 'document.approved',
  DOCUMENT_PUBLISHED: 'document.published',
  ACKNOWLEDGMENT_ASSIGNED: 'acknowledgment.assigned',
  // Phase 7 — Public read-only API: client lifecycle (web) + per-call access (api).
  API_CLIENT_CREATED: 'api_client.created',
  API_CLIENT_UPDATED: 'api_client.updated',
  API_CLIENT_REVOKED: 'api_client.revoked',
  API_CLIENT_ROTATED: 'api_client.rotated',
  API_DOCUMENTS_LISTED: 'api.documents.listed',
  API_DOCUMENT_READ: 'api.document.read',
  API_CONTENT_READ: 'api.content.read',
  API_DOWNLOAD_ISSUED: 'api.download.issued',
  API_VERSIONS_READ: 'api.versions.read',
  API_SEARCH: 'api.search',
  // Phase 8 — bulk import & consolidation.
  IMPORT_COMPLETED: 'import.completed',
  // Phase 11 - review annotations.
  ANNOTATION_CREATED: 'annotation.created',
  ANNOTATION_RESOLVED: 'annotation.resolved',
  ANNOTATION_REOPENED: 'annotation.reopened',
  ANNOTATION_DELETED: 'annotation.deleted',
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
  [AUDIT_ACTIONS.EXTRACTION_REINDEXED]: 'Text extraction reindexed',
  [AUDIT_ACTIONS.EXTRACTION_PROCESSED]: 'Text extraction processed',
  [AUDIT_ACTIONS.ACL_CHANGED]: 'Access changed',
  [AUDIT_ACTIONS.ACCESS_DENIED]: 'Access denied',
  [AUDIT_ACTIONS.USER_LOGIN]: 'Sign-in',
  [AUDIT_ACTIONS.USER_LOGIN_FAILED]: 'Failed sign-in',
  [AUDIT_ACTIONS.USER_PASSWORD_RESET]: 'Password reset',
  [AUDIT_ACTIONS.REVIEW_ASSIGNED]: 'Reviewer assigned',
  [AUDIT_ACTIONS.REVIEW_TASK_CREATED]: 'Review task created',
  [AUDIT_ACTIONS.REVIEW_COMPLETED]: 'Review completed',
  [AUDIT_ACTIONS.SMTP_CONFIG_CHANGED]: 'Email settings changed',
  [AUDIT_ACTIONS.SMTP_TEST_SENT]: 'Test email sent',
  [AUDIT_ACTIONS.ATTESTATION_REVIEWED]: 'Reviewed (signed off)',
  [AUDIT_ACTIONS.ATTESTATION_APPROVED]: 'Approved (signed off)',
  [AUDIT_ACTIONS.ATTESTATION_ACKNOWLEDGED]: 'Acknowledged (read & understood)',
  [AUDIT_ACTIONS.DOCUMENT_APPROVED]: 'Document approved',
  [AUDIT_ACTIONS.DOCUMENT_PUBLISHED]: 'Document published',
  [AUDIT_ACTIONS.ACKNOWLEDGMENT_ASSIGNED]: 'Distributed for acknowledgment',
  [AUDIT_ACTIONS.API_CLIENT_CREATED]: 'API client created',
  [AUDIT_ACTIONS.API_CLIENT_UPDATED]: 'API client updated',
  [AUDIT_ACTIONS.API_CLIENT_REVOKED]: 'API client revoked',
  [AUDIT_ACTIONS.API_CLIENT_ROTATED]: 'API client secret rotated',
  [AUDIT_ACTIONS.API_DOCUMENTS_LISTED]: 'API: documents listed',
  [AUDIT_ACTIONS.API_DOCUMENT_READ]: 'API: document read',
  [AUDIT_ACTIONS.API_CONTENT_READ]: 'API: content read',
  [AUDIT_ACTIONS.API_DOWNLOAD_ISSUED]: 'API: download issued',
  [AUDIT_ACTIONS.API_VERSIONS_READ]: 'API: versions read',
  [AUDIT_ACTIONS.API_SEARCH]: 'API: search',
  [AUDIT_ACTIONS.IMPORT_COMPLETED]: 'Bulk import completed',
  [AUDIT_ACTIONS.ANNOTATION_CREATED]: 'Annotation created',
  [AUDIT_ACTIONS.ANNOTATION_RESOLVED]: 'Annotation resolved',
  [AUDIT_ACTIONS.ANNOTATION_REOPENED]: 'Annotation reopened',
  [AUDIT_ACTIONS.ANNOTATION_DELETED]: 'Annotation deleted',
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

// ---------------------------------------------------------------------------
// Review annotations (Phase 11)
// ---------------------------------------------------------------------------

export type AnnotationType = 'comment' | 'issue' | 'suggested_change';
export type AnnotationStatus = 'open' | 'resolved';

export const ANNOTATION_TYPES: readonly AnnotationType[] = [
  'comment',
  'issue',
  'suggested_change',
] as const;

export const ANNOTATION_STATUSES: readonly AnnotationStatus[] = ['open', 'resolved'] as const;

export const ANNOTATION_TYPE_LABELS: Record<AnnotationType, string> = {
  comment: 'Comment',
  issue: 'Issue',
  suggested_change: 'Suggested change',
};

export interface AnnotationRect {
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DocumentAnnotationItem extends AnnotationRect {
  id: string;
  documentId: string;
  versionId: string;
  authorId: string;
  authorName: string | null;
  type: AnnotationType;
  status: AnnotationStatus;
  body: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  resolvedByName: string | null;
}

export interface DocumentAnnotationListResponse {
  items: DocumentAnnotationItem[];
  /**
   * Server-calculated capability for the current user. This includes direct
   * `document.comment`, reviewer assignment, or an open review task.
   */
  canAnnotate: boolean;
  /** Delete moderation is intentionally narrower than annotation rights. */
  canComplianceDelete: boolean;
}

export interface CreateAnnotationInput extends AnnotationRect {
  type?: AnnotationType;
  body: string;
}

// ---------------------------------------------------------------------------
// QC Review scheduling + Email/SMTP admin (Phase 5, PM-0501..PM-0509)
// ---------------------------------------------------------------------------

/** Lifecycle of a scheduled review task. */
export type ReviewTaskStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'overdue'
  | 'cancelled';

export const REVIEW_TASK_STATUSES: readonly ReviewTaskStatus[] = [
  'pending',
  'in_progress',
  'completed',
  'overdue',
  'cancelled',
] as const;

/** Task statuses that still require action (not completed/cancelled). */
export const OPEN_REVIEW_TASK_STATUSES: readonly ReviewTaskStatus[] = [
  'pending',
  'in_progress',
  'overdue',
] as const;

/** Human labels for review-task statuses (UI badges). */
export const REVIEW_TASK_STATUS_LABELS: Record<ReviewTaskStatus, string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  completed: 'Completed',
  overdue: 'Overdue',
  cancelled: 'Cancelled',
};

/** Default lead time (days) before a document's next review that a task is raised. */
export const DEFAULT_REVIEW_LEAD_DAYS = 14;

/** An assigned reviewer on a document (from ReviewAssignment). */
export interface ReviewerAssignment {
  userId: string;
  name: string | null;
  email: string | null;
  assignedAt: string;
}

/** One scheduled review task as surfaced to the review API + dashboard. */
export interface ReviewTaskItem {
  id: string;
  documentId: string;
  documentTitle: string | null;
  documentNumber: string | null;
  versionId: string | null;
  dueDate: string;
  status: ReviewTaskStatus;
  assignedToId: string;
  assignedToName: string | null;
  completedAt: string | null;
  completedByName: string | null;
  notes: string | null;
  createdAt: string;
  /** The parent document's cadence — lets the complete modal decide next-date UX. */
  reviewCadence: ReviewCadence;
  /** Open annotations on the task version/current version, for reviewer triage. */
  unresolvedAnnotationCount: number;
}

/** Body for completing a review task. */
export interface CompleteReviewInput {
  notes?: string;
  /** Required when the document cadence is `none`/`custom`; overrides otherwise. */
  newNextReviewDate?: string;
  /**
   * Typed sign-off name captured on the immutable `reviewed` Attestation. Defaults
   * to the acting user's name server-side when omitted (AGENTS.md §10b).
   */
  signatureName?: string;
  /** Optional role/title recorded alongside the sign-off signature. */
  signatureRole?: string;
}

/** Result of a review sweep run (cron or manual trigger). */
export interface ReviewSweepResult {
  tasksCreated: number;
  overdueMarked: number;
  documentsConsidered: number;
}

/** Clinic-wide review-compliance snapshot for the report cards. */
export interface ComplianceSummary {
  totalDocuments: number;
  current: number;
  dueSoon: number;
  overdue: number;
  /** Whole-number percent (0–100) of in-force documents not overdue. */
  percentCurrent: number;
}

// ---- Email / SMTP admin --------------------------------------------------

/** Category of a sent notification, for the log + filters. */
export type NotificationType =
  | 'review_reminder'
  | 'review_overdue'
  | 'password_reset'
  | 'account_locked'
  | 'smtp_test'
  | 'other';

export const NOTIFICATION_TYPES: readonly NotificationType[] = [
  'review_reminder',
  'review_overdue',
  'password_reset',
  'account_locked',
  'smtp_test',
  'other',
] as const;

/** Delivery outcome recorded for each attempted send. */
export type NotificationStatus = 'sent' | 'failed';

/**
 * SMTP settings as surfaced to the admin UI. The stored password is NEVER
 * returned — only `hasPassword` indicates whether one is set. `source` says
 * whether these values come from a saved DB row (`db`) or the env fallback (`env`).
 */
export interface SmtpConfigView {
  host: string;
  port: number;
  secure: boolean;
  username: string | null;
  fromAddress: string;
  fromName: string;
  enabled: boolean;
  hasPassword: boolean;
  updatedAt: string | null;
  source: 'db' | 'env';
}

/** Body for PUT /smtp/config. `password` is write-only (never echoed back). */
export interface UpdateSmtpConfigInput {
  host: string;
  port: number;
  secure: boolean;
  username?: string | null;
  /** Omit to keep the existing password; empty string clears it. */
  password?: string;
  fromAddress: string;
  fromName: string;
  enabled: boolean;
}

/** One recorded notification send (review reminder, password reset, test…). */
export interface NotificationLogItem {
  id: string;
  toEmail: string;
  toUserId: string | null;
  subject: string;
  type: string;
  reviewTaskId: string | null;
  status: NotificationStatus;
  error: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Attestation (sign-off) + acknowledgment distribution (Phase 6, PM-0601..PM-0609)
// ---------------------------------------------------------------------------

/** The compliance action an immutable Attestation records. */
export type AttestationAction = 'reviewed' | 'approved' | 'acknowledged';

export const ATTESTATION_ACTIONS: readonly AttestationAction[] = [
  'reviewed',
  'approved',
  'acknowledged',
] as const;

/** Human labels for attestation actions (approval-chain UI). */
export const ATTESTATION_ACTION_LABELS: Record<AttestationAction, string> = {
  reviewed: 'Reviewed',
  approved: 'Approved',
  acknowledged: 'Acknowledged',
};

/** Lifecycle of a staff acknowledgment assignment. */
export type AckStatus = 'pending' | 'completed' | 'overdue' | 'cancelled';

export const ACK_STATUSES: readonly AckStatus[] = [
  'pending',
  'completed',
  'overdue',
  'cancelled',
] as const;

/** Human labels for acknowledgment statuses (badges). */
export const ACK_STATUS_LABELS: Record<AckStatus, string> = {
  pending: 'Pending',
  completed: 'Completed',
  overdue: 'Overdue',
  cancelled: 'Cancelled',
};

/**
 * One immutable attestation as surfaced to the approval-chain panel + evidence
 * views. `versionNumber` is the resolved number of `versionId` (null when the
 * sign-off predates any file). Never carries the raw signature bytes — this IS
 * the signature (typed name + role + timestamp + IP).
 */
export interface AttestationItem {
  id: string;
  documentId: string;
  versionId: string | null;
  versionNumber: number | null;
  reviewTaskId: string | null;
  acknowledgmentAssignmentId: string | null;
  userId: string;
  userName: string | null;
  action: AttestationAction;
  signatureName: string;
  signatureRole: string | null;
  comments: string | null;
  ipAddress: string | null;
  signedAt: string;
}

/** Body for POST /documents/:id/approve. */
export interface ApproveDocumentInput {
  /** Typed sign-off name; defaults to the acting user's name when omitted. */
  signatureName?: string;
  signatureRole?: string;
  comments?: string;
  /**
   * When true, the document is set to `published` (and acknowledgment is
   * re-triggered for the current version); otherwise it is set to `approved`.
   */
  publish?: boolean;
}

/** Result of an approve/publish sign-off. */
export interface ApproveDocumentResult {
  documentId: string;
  status: DocumentStatus;
  attestation: AttestationItem;
  /** Fresh pending acknowledgments created by a publish re-trigger (0 otherwise). */
  acknowledgmentsRetriggered: number;
}

/**
 * Body for POST /documents/:id/acknowledgments — distribute the current version
 * for read-and-acknowledge. Supply explicit user ids and/or role names (expanded
 * to their members); the union is de-duplicated and assigned idempotently.
 */
export interface DistributeAcknowledgmentInput {
  assigneeIds?: string[];
  roleNames?: string[];
  /** Optional ISO due date applied to every created/updated assignment. */
  dueDate?: string;
}

/** One assignee's acknowledgment status for a document version (manager view). */
export interface AcknowledgmentStatusRow {
  assignmentId: string;
  assigneeId: string;
  assigneeName: string | null;
  assigneeEmail: string | null;
  status: AckStatus;
  dueDate: string | null;
  completedAt: string | null;
}

/**
 * Per-version acknowledgment status + completion percentage for the manager view.
 * `versionId` is null when the document has never been distributed.
 */
export interface AcknowledgmentStatusSummary {
  documentId: string;
  versionId: string | null;
  versionNumber: number | null;
  total: number;
  completed: number;
  pending: number;
  overdue: number;
  /** Whole-number percent (0–100) of assignees who have acknowledged. */
  percentComplete: number;
  rows: AcknowledgmentStatusRow[];
}

/** One of my acknowledgment assignments (the staff "My Acknowledgments" list). */
export interface MyAcknowledgmentItem {
  id: string;
  documentId: string;
  documentTitle: string | null;
  documentNumber: string | null;
  versionId: string;
  versionNumber: number | null;
  status: AckStatus;
  dueDate: string | null;
  completedAt: string | null;
  createdAt: string;
  assignedByName: string | null;
}

/**
 * Body for POST /acknowledgments/:id/acknowledge. `hasViewed` MUST be true — the
 * assignee has to open and read the document first (AGENTS.md §10b).
 */
export interface AcknowledgeInput {
  hasViewed: boolean;
  /** Typed sign-off name; defaults to the acting user's name when omitted. */
  signatureName?: string;
  signatureRole?: string;
  comments?: string;
}

/**
 * The data model that feeds cover-page PDF generation (pdf-lib). Assembled purely
 * from live metadata so the source version bytes are never mutated (AGENTS.md §10).
 * Unit-tested independently of the PDF rendering.
 */
export interface CoverPageData {
  title: string;
  documentNumber: string | null;
  version: number | null;
  status: DocumentStatus;
  category: string | null;
  owner: string | null;
  effectiveDate: string | null;
  reviewCadence: ReviewCadence;
  nextReviewDate: string | null;
  approvalChain: {
    action: AttestationAction;
    signatureName: string;
    signatureRole: string | null;
    signedAt: string;
  }[];
  revisionHistory: {
    version: number;
    date: string;
    uploadedBy: string | null;
    changeSummary: string | null;
  }[];
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Public read-only API v1 — API clients + integration surface (Phase 7)
// ---------------------------------------------------------------------------

/**
 * Scopes a public API client can hold. `documents:read` is the baseline (list +
 * metadata + versions + search); `content:read` additionally unlocks extracted
 * text; `download` unlocks short-lived presigned file downloads. Scopes are
 * additive and independent — a client may hold any subset — and, per AGENTS.md §8,
 * access to extracted text obeys the SAME gate as file download (its own scope).
 */
export type ApiScope = 'documents:read' | 'content:read' | 'download';

export const API_SCOPES: readonly ApiScope[] = [
  'documents:read',
  'content:read',
  'download',
] as const;

/** The baseline scope every client should hold to do anything useful. */
export const API_DEFAULT_SCOPE: ApiScope = 'documents:read';

/** Human labels for scopes (management UI checkboxes). */
export const API_SCOPE_LABELS: Record<ApiScope, string> = {
  'documents:read': 'Read document metadata & search',
  'content:read': 'Read extracted text content',
  download: 'Download document files',
};

/**
 * An API client as surfaced to the management UI. NEVER carries the secret hash —
 * the plaintext secret is shown exactly once at create/rotate time via
 * {@link ApiClientSecret}.
 */
export interface ApiClientItem {
  id: string;
  name: string;
  clientId: string;
  scopes: ApiScope[];
  allowedCategoryIds: string[];
  enabled: boolean;
  createdAt: string;
  createdByName: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/**
 * The one-time secret reveal returned by create/rotate. `credential` is the
 * ready-to-use `clientId.secret` bearer value; it can NEVER be retrieved again
 * (only its Argon2 hash is stored — AGENTS.md §8).
 */
export interface ApiClientSecret {
  client: ApiClientItem;
  secret: string;
  credential: string;
}

/** Body for POST /api-clients. */
export interface CreateApiClientInput {
  name: string;
  scopes: ApiScope[];
  allowedCategoryIds?: string[];
}

/** Body for PATCH /api-clients/:id — adjust scopes, category allow-list, or enabled. */
export interface UpdateApiClientInput {
  scopes?: ApiScope[];
  allowedCategoryIds?: string[];
  enabled?: boolean;
}

// ---- Public API v1 response shapes (stable external contract) --------------

/** One document as exposed by the public API list/search/detail responses. */
export interface ApiDocument {
  id: string;
  title: string;
  documentNumber: string | null;
  categoryId: string | null;
  categoryName: string | null;
  status: DocumentStatus;
  accessLevel: AccessLevel;
  tags: string[];
  version: number | null;
  effectiveDate: string | null;
  updatedAt: string;
}

/** Extracted-text payload (scope `content:read`). */
export interface ApiDocumentContent {
  documentId: string;
  versionId: string | null;
  version: number | null;
  extractedText: string;
  hasExtractedText: boolean;
}

/** Presigned-download payload (scope `download`). */
export interface ApiDownloadTicket {
  url: string;
  expiresIn: number;
  fileName: string;
  version: number | null;
}

/** One immutable version in the public versions response (metadata only). */
export interface ApiDocumentVersion {
  version: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  createdAt: string;
  hasExtractedText: boolean;
}

/**
 * One search hit. `score` + `snippet` are keyword-derived today, but the shape is
 * deliberately future-proof for a pgvector semantic backend behind the SAME
 * contract (the deferred RAG phase) — a caller written against this response does
 * not change when search becomes semantic.
 */
export interface ApiSearchHit {
  document: ApiDocument;
  score: number;
  snippet: string | null;
}

export interface ApiSearchResponse {
  query: string;
  total: number;
  page: number;
  pageSize: number;
  items: ApiSearchHit[];
}

// ---------------------------------------------------------------------------
// Import & Consolidation — bulk upload + CSV manifest importer (Phase 8, PM-0801..PM-0806)
// ---------------------------------------------------------------------------

/** Outcome of processing one manifest row / bulk file. */
export type ImportItemStatus = 'pending' | 'created' | 'duplicate' | 'error' | 'skipped';

export const IMPORT_ITEM_STATUSES: readonly ImportItemStatus[] = [
  'pending',
  'created',
  'duplicate',
  'error',
  'skipped',
] as const;

/** Human labels for import row outcomes (report badges). */
export const IMPORT_ITEM_STATUS_LABELS: Record<ImportItemStatus, string> = {
  pending: 'Pending',
  created: 'Created',
  duplicate: 'Duplicate',
  error: 'Error',
  skipped: 'Skipped',
};

/** Coarse lifecycle of a whole import batch. */
export type ImportBatchStatus = 'processing' | 'completed' | 'failed';

/**
 * The exact, ordered manifest columns. `title` is REQUIRED; every other column is
 * optional. A `category` may be a `/`-separated path (auto-created, reused if it
 * already exists). `tags` are separated by `;` or `|` within the single CSV cell.
 * `owner` is an email (defaults to the importer when blank or unknown).
 */
export const IMPORT_MANIFEST_COLUMNS = [
  'fileName',
  'title',
  'category',
  'documentNumber',
  'owner',
  'tags',
  'accessLevel',
  'reviewCadence',
  'description',
] as const;

export type ImportManifestColumn = (typeof IMPORT_MANIFEST_COLUMNS)[number];

/**
 * A ready-to-download sample manifest (header + two example rows) offered by the
 * Import UI so non-technical staff have a correct template to fill in. Kept in the
 * shared package so the header can never drift from {@link IMPORT_MANIFEST_COLUMNS}.
 */
export const SAMPLE_MANIFEST_CSV = [
  IMPORT_MANIFEST_COLUMNS.join(','),
  'seclusion-policy.pdf,Seclusion & Restraint Policy,Policies & Procedures/Clinical,PP-042,jane@clinic.org,CARF;safety,restricted,annual,Governs seclusion and restraint use',
  'rn-job-description.docx,Registered Nurse Job Description,Job Descriptions,JD-011,,HR,restricted,none,',
  '',
].join('\n');

/** One line of the import report (per manifest row / bulk file). */
export interface ImportItemResult {
  id: string;
  rowNumber: number;
  title: string | null;
  documentNumber: string | null;
  categoryName: string | null;
  fileName: string | null;
  status: ImportItemStatus;
  /** The created OR matched (duplicate) document, when there is one. */
  documentId: string | null;
  /** Human-readable detail: duplicate reason, error cause, or a note. */
  message: string | null;
}

/** Rollup summary of an import batch (list view + report header). */
export interface ImportBatchSummary {
  id: string;
  fileName: string | null;
  totalRows: number;
  createdCount: number;
  duplicateCount: number;
  errorCount: number;
  status: ImportBatchStatus;
  createdById: string;
  createdByName: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** A batch plus its full per-row report (GET /imports/:id). */
export interface ImportBatchDetail extends ImportBatchSummary {
  items: ImportItemResult[];
}
