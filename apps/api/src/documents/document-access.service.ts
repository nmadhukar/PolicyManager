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
 * FINDING-012: the ACL grant's `permission` is enforced as a MINIMUM rank the
 * grant must satisfy for the requested action (view < download < edit <
 * approve) — a "view"-only grant unlocks viewing/downloading a confidential
 * document but NOT editing it, approving it, or managing its ACL (which is
 * itself gated as an 'edit' action). A grant recorded as "edit" or "approve"
 * also satisfies every lower-ranked action, so an edit-grant holder can still
 * view/download.
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
   * FINDING-012: rank of each ACL grant permission / access action, used to
   * decide whether a grant recorded at one level satisfies a request for
   * another. "view" and "download" are the same read-only tier (matching
   * {@link requiredPermission}, which gates both behind document.read alone);
   * "edit" and "approve" are strictly higher tiers. Higher rank implies every
   * lower/equal one.
   */
  private static readonly PERMISSION_RANK: Record<string, number> = {
    view: 0,
    download: 0,
    edit: 1,
    approve: 2,
  };

  /** True when a grant recorded with `granted` permission covers `requested`. */
  private static grantSatisfies(granted: string, requested: AccessAction): boolean {
    const grantedRank = DocumentAccessService.PERMISSION_RANK[granted] ?? -1;
    const requiredRank = DocumentAccessService.PERMISSION_RANK[requested] ?? Infinity;
    return grantedRank >= requiredRank;
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
    return this.hasGrant(user, doc, action);
  }

  /** Enforcing variant: throws 403 when access is denied. */
  async assertCanAccess(user: AuthUser, doc: AccessDocument, action: AccessAction): Promise<void> {
    if (!(await this.canAccess(user, doc, action))) {
      throw new ForbiddenException('You do not have access to this document');
    }
  }

  /**
   * Access decision for a bare user id (no AuthUser in hand). Resolves the user's
   * roles + permissions from the DB, then applies the same {@link canAccess} logic.
   * Used by server-to-server paths that carry only an id (e.g. the OnlyOffice
   * content token — SH2 defence in depth). A disabled/unknown user is denied.
   */
  async canAccessByUserId(
    userId: string,
    doc: AccessDocument,
    action: AccessAction,
  ): Promise<boolean> {
    const user = await this.resolveAuthUser(userId);
    if (!user) return false;
    return this.canAccess(user, doc, action);
  }

  /** Loads the RBAC context (roles + de-duplicated permissions) for an active user. */
  private async resolveAuthUser(userId: string): Promise<AuthUser | null> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        status: true,
        roles: {
          select: {
            role: { select: { name: true, permissions: { select: { permission: { select: { key: true } } } } } },
          },
        },
      },
    });
    if (!u || u.status !== 'active') return null;
    const roles = u.roles.map((ur) => ur.role.name);
    const permissions = Array.from(
      new Set(u.roles.flatMap((ur) => ur.role.permissions.map((rp) => rp.permission.key))),
    );
    return { id: u.id, email: u.email, name: u.name, roles, permissions, mustChangePassword: false };
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

  /**
   * True when the user (or a role they hold) has an ACL grant on the
   * doc/category whose recorded `permission` satisfies `action` (FINDING-012:
   * a "view" grant no longer authorizes "edit"/"approve").
   */
  private async hasGrant(user: AuthUser, doc: AccessDocument, action: AccessAction): Promise<boolean> {
    const roleIds = await this.roleIdsOf(user);
    const grantMatch = this.grantMatch(user.id, roleIds);
    const scope: Prisma.DocumentAclWhereInput[] = [{ documentId: doc.id }];
    if (doc.categoryId) scope.push({ categoryId: doc.categoryId });
    const grants = await this.prisma.documentAcl.findMany({
      where: { AND: [{ OR: scope }, grantMatch] },
      select: { permission: true },
    });
    return grants.some((g) => DocumentAccessService.grantSatisfies(g.permission, action));
  }

  /**
   * FINDING-010: batched {@link canAccess} for a SAME `action` across many
   * documents — resolves the caller's roleIds ONCE (they cannot change
   * mid-request) and issues a single ACL grant lookup for every confidential,
   * non-owned document instead of one roleIdsOf + documentAcl.count pair per
   * document. Returns the identical per-document decision `canAccess` would.
   */
  async canAccessMany(
    user: AuthUser,
    docs: AccessDocument[],
    action: AccessAction,
  ): Promise<Map<string, boolean>> {
    const decision = new Map<string, boolean>();
    const required = DocumentAccessService.requiredPermission(action);
    if (!(user.permissions ?? []).includes(required)) {
      docs.forEach((d) => decision.set(d.id, false));
      return decision;
    }

    const isAdmin = DocumentAccessService.isAdmin(user);
    const needsGrantCheck = docs.filter(
      (d) => d.accessLevel === 'confidential' && !isAdmin && d.ownerId !== user.id,
    );

    let grantedDocumentIds = new Set<string>();
    let grantedCategoryIds = new Set<string>();
    if (needsGrantCheck.length > 0) {
      const roleIds = await this.roleIdsOf(user);
      const grantMatch = this.grantMatch(user.id, roleIds);
      const documentIds = needsGrantCheck.map((d) => d.id);
      const categoryIds = needsGrantCheck
        .map((d) => d.categoryId)
        .filter((id): id is string => !!id);
      const grants = await this.prisma.documentAcl.findMany({
        where: {
          AND: [
            {
              OR: [
                { documentId: { in: documentIds } },
                ...(categoryIds.length ? [{ categoryId: { in: categoryIds } }] : []),
              ],
            },
            grantMatch,
          ],
        },
        select: { documentId: true, categoryId: true, permission: true },
      });
      // FINDING-012: only grants whose recorded permission satisfies `action`
      // count toward unlocking the document/category for this action.
      const sufficientGrants = grants.filter((g) =>
        DocumentAccessService.grantSatisfies(g.permission, action),
      );
      grantedDocumentIds = new Set(
        sufficientGrants.map((g) => g.documentId).filter((id): id is string => !!id),
      );
      grantedCategoryIds = new Set(
        sufficientGrants.map((g) => g.categoryId).filter((id): id is string => !!id),
      );
    }

    for (const doc of docs) {
      if (doc.accessLevel !== 'confidential' || isAdmin || doc.ownerId === user.id) {
        decision.set(doc.id, true);
        continue;
      }
      decision.set(
        doc.id,
        grantedDocumentIds.has(doc.id) ||
          (!!doc.categoryId && grantedCategoryIds.has(doc.categoryId)),
      );
    }
    return decision;
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
