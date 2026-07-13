import { ForbiddenException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  PERMISSIONS,
  ROLES,
  type AccessAction,
  type AuthUser,
  type PermissionKey,
} from '@policymanager/shared';
import { PrismaService } from '../prisma/prisma.service';

/** The minimal document fields an access decision needs. */
export interface AccessDocument {
  id: string;
  ownerId: string;
  /** 'public' | 'restricted' | 'confidential' (Prisma enum string). */
  accessLevel: string;
  categoryId: string | null;
}

/**
 * Central document authorization (AGENTS.md §8). Combines TWO gates:
 *
 *  (a) RBAC — the caller must hold the permission for the action
 *      (view/download → document.read, edit → document.write, approve →
 *      document.approve).
 *  (b) Access level —
 *      • public / restricted: any RBAC holder may access;
 *      • confidential: ONLY the owner, an Admin, or a principal (the user or one
 *        of their roles) named by a DocumentAcl grant on the document OR its
 *        category. `document.read` alone is NOT enough.
 *
 * The ACL grant's `permission` is recorded intent (shown in the UI) and reserved
 * for finer future enforcement; today ANY grant unlocks a confidential document
 * and the RBAC gate governs what the principal can then do — so a "view" grant
 * makes the document both viewable and downloadable, matching the product spec.
 */
@Injectable()
export class DocumentAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /** RBAC permission gating each action. */
  static requiredPermission(action: AccessAction): PermissionKey {
    switch (action) {
      case 'edit':
        return PERMISSIONS.DOCUMENT_WRITE;
      case 'approve':
        return PERMISSIONS.DOCUMENT_APPROVE;
      case 'view':
      case 'download':
      default:
        return PERMISSIONS.DOCUMENT_READ;
    }
  }

  /** Admins are super-viewers of confidential documents. */
  static isAdmin(user: Pick<AuthUser, 'roles'>): boolean {
    return (user.roles ?? []).includes(ROLES.ADMIN);
  }

  /**
   * Decides whether `user` may perform `action` on `doc`. Pure boolean — the
   * caller decides whether to 404, 403, or filter. May hit the DB (ACL lookup)
   * only for confidential documents where the user is neither owner nor Admin.
   */
  async canAccess(user: AuthUser, doc: AccessDocument, action: AccessAction): Promise<boolean> {
    // (a) RBAC gate.
    const required = DocumentAccessService.requiredPermission(action);
    if (!(user.permissions ?? []).includes(required)) return false;

    // (b) Access-level gate.
    if (doc.accessLevel !== 'confidential') return true;
    if (DocumentAccessService.isAdmin(user) || doc.ownerId === user.id) return true;
    return this.hasGrant(user, doc);
  }

  /** Enforcing variant: throws 403 when access is denied. */
  async assertCanAccess(user: AuthUser, doc: AccessDocument, action: AccessAction): Promise<void> {
    if (!(await this.canAccess(user, doc, action))) {
      throw new ForbiddenException('You do not have access to this document');
    }
  }

  /**
   * A Prisma where-clause that filters a document list down to what `user` may
   * VIEW — used to exclude confidential documents the caller has no grant for.
   * AND this into the base list query. Admins get an empty clause (see all).
   */
  async buildListWhere(user: AuthUser): Promise<Prisma.DocumentWhereInput> {
    if (DocumentAccessService.isAdmin(user)) return {};
    const roleIds = await this.roleIdsOf(user);
    const grantMatch = this.grantMatch(user.id, roleIds);
    return {
      OR: [
        { accessLevel: { not: 'confidential' } },
        { accessLevel: 'confidential', ownerId: user.id },
        { accessLevel: 'confidential', acls: { some: grantMatch } },
        { accessLevel: 'confidential', category: { acls: { some: grantMatch } } },
      ],
    };
  }

  /** True when the user (or a role they hold) has ANY ACL grant on the doc/category. */
  private async hasGrant(user: AuthUser, doc: AccessDocument): Promise<boolean> {
    const roleIds = await this.roleIdsOf(user);
    const grantMatch = this.grantMatch(user.id, roleIds);
    const scope: Prisma.DocumentAclWhereInput[] = [{ documentId: doc.id }];
    if (doc.categoryId) scope.push({ categoryId: doc.categoryId });
    const count = await this.prisma.documentAcl.count({
      where: { AND: [{ OR: scope }, grantMatch] },
    });
    return count > 0;
  }

  /** Resolves the user's role ids from the join table (source of truth). */
  private async roleIdsOf(user: Pick<AuthUser, 'id'>): Promise<string[]> {
    const rows = await this.prisma.userRole.findMany({
      where: { userId: user.id },
      select: { roleId: true },
    });
    return rows.map((r) => r.roleId);
  }

  /** ACL match for a user principal OR any of their role principals. */
  private grantMatch(userId: string, roleIds: string[]): Prisma.DocumentAclWhereInput {
    return {
      OR: [
        { principalType: 'user', principalId: userId },
        { principalType: 'role', principalId: { in: roleIds } },
      ],
    };
  }
}
