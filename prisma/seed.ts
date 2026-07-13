/**
 * Idempotent seed for Phase 2 (Auth & RBAC).
 *
 * Creates:
 *  - every Permission from the shared PERMISSIONS catalog,
 *  - the 5 system Roles with their permission sets,
 *  - one bootstrap Admin user (email admin@policymanager.local).
 *
 * Safe to run repeatedly: all writes are upserts and role/permission links are
 * reconciled to the desired state. Passwords are hashed with Argon2 (AGENTS.md §8).
 *
 * Run: `npm run db:seed` (root) or `npm run seed` (apps/api).
 */
import { resolve } from 'path';
import * as dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { PERMISSIONS, ROLES } from '@policymanager/shared';

// Standalone script: load the repo-root .env (Prisma reads DATABASE_URL from env).
dotenv.config({ path: resolve(__dirname, '../.env') });

const prisma = new PrismaClient();

const ALL_PERMISSIONS = Object.values(PERMISSIONS);

const PERMISSION_DESCRIPTIONS: Record<string, string> = {
  [PERMISSIONS.DOCUMENT_READ]: 'View and download documents within scope.',
  [PERMISSIONS.DOCUMENT_WRITE]: 'Upload new documents and create new versions.',
  [PERMISSIONS.DOCUMENT_APPROVE]: 'Approve documents in the review workflow.',
  [PERMISSIONS.REVIEW_MANAGE]: 'Manage review schedules, tasks, and sign-offs.',
  [PERMISSIONS.USER_MANAGE]: 'Manage users, roles, and access.',
  [PERMISSIONS.STORAGE_MANAGE]: 'Administer object storage buckets and prefixes.',
  [PERMISSIONS.SMTP_MANAGE]: 'Configure SMTP and notification settings.',
  [PERMISSIONS.API_MANAGE]: 'Manage public API clients and keys.',
  [PERMISSIONS.AUDIT_READ]: 'Read the immutable audit trail (compliance evidence).',
};

/**
 * Desired role -> permission mapping. Admin is granted every permission so it
 * never drifts as new permissions are added.
 */
const ROLE_PERMISSIONS: Record<string, string[]> = {
  [ROLES.ADMIN]: [...ALL_PERMISSIONS],
  [ROLES.COMPLIANCE_OFFICER]: [
    PERMISSIONS.DOCUMENT_READ,
    PERMISSIONS.DOCUMENT_WRITE,
    PERMISSIONS.DOCUMENT_APPROVE,
    PERMISSIONS.REVIEW_MANAGE,
    PERMISSIONS.AUDIT_READ,
  ],
  [ROLES.MANAGER]: [
    PERMISSIONS.DOCUMENT_READ,
    PERMISSIONS.DOCUMENT_WRITE,
    PERMISSIONS.REVIEW_MANAGE,
  ],
  [ROLES.STAFF]: [PERMISSIONS.DOCUMENT_READ],
  // Auditor is a read-only compliance role: read documents + read the audit trail.
  [ROLES.AUDITOR]: [PERMISSIONS.DOCUMENT_READ, PERMISSIONS.AUDIT_READ],
};

const ROLE_DESCRIPTIONS: Record<string, string> = {
  [ROLES.ADMIN]: 'Full administrative access.',
  [ROLES.COMPLIANCE_OFFICER]: 'Owns document lifecycle, approvals, and reviews.',
  [ROLES.MANAGER]: 'Uploads/versions documents and manages reviews for their area.',
  [ROLES.STAFF]: 'Reads and acknowledges assigned documents.',
  [ROLES.AUDITOR]: 'Read-only access for audit and survey evidence.',
};

async function seedPermissions(): Promise<Map<string, string>> {
  const byKey = new Map<string, string>();
  for (const key of ALL_PERMISSIONS) {
    const perm = await prisma.permission.upsert({
      where: { key },
      update: { description: PERMISSION_DESCRIPTIONS[key] },
      create: { key, description: PERMISSION_DESCRIPTIONS[key] },
    });
    byKey.set(key, perm.id);
  }
  return byKey;
}

async function seedRoles(permIdByKey: Map<string, string>): Promise<Map<string, string>> {
  const roleIdByName = new Map<string, string>();
  for (const [name, permKeys] of Object.entries(ROLE_PERMISSIONS)) {
    const role = await prisma.role.upsert({
      where: { name },
      update: { description: ROLE_DESCRIPTIONS[name], isSystem: true },
      create: { name, description: ROLE_DESCRIPTIONS[name], isSystem: true },
    });
    roleIdByName.set(name, role.id);

    // Reconcile the role's permission set to exactly the desired keys.
    const desiredIds = permKeys.map((k) => permIdByKey.get(k)!).filter(Boolean);
    await prisma.rolePermission.deleteMany({
      where: { roleId: role.id, permissionId: { notIn: desiredIds } },
    });
    for (const permissionId of desiredIds) {
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId } },
        update: {},
        create: { roleId: role.id, permissionId },
      });
    }
  }
  return roleIdByName;
}

async function seedAdmin(adminRoleId: string): Promise<void> {
  const email = 'admin@policymanager.local';
  const password = process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe!123';
  const passwordHash = await argon2.hash(password);

  const admin = await prisma.user.upsert({
    where: { email },
    // Do not clobber an operator-changed password on re-seed.
    update: { name: 'PolicyManager Admin', status: 'active' },
    create: { email, name: 'PolicyManager Admin', passwordHash, status: 'active' },
  });

  await prisma.userIdentity.upsert({
    where: { provider_subject: { provider: 'local', subject: email } },
    update: {},
    create: { userId: admin.id, provider: 'local', subject: email, email },
  });

  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: admin.id, roleId: adminRoleId } },
    update: {},
    create: { userId: admin.id, roleId: adminRoleId },
  });
}

async function main(): Promise<void> {
  const permIdByKey = await seedPermissions();
  const roleIdByName = await seedRoles(permIdByKey);
  const adminRoleId = roleIdByName.get(ROLES.ADMIN);
  if (!adminRoleId) throw new Error('Admin role was not seeded');
  await seedAdmin(adminRoleId);

  // eslint-disable-next-line no-console
  console.log(
    `Seed complete: ${permIdByKey.size} permissions, ${roleIdByName.size} roles, admin user ready.`,
  );
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
