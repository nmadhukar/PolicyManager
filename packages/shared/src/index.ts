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
