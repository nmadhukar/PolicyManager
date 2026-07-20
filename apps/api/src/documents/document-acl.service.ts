import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AUDIT_ACTIONS, type AclGrant, type AuthUser } from '@policymanager/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { RequestContext } from '../audit/request-context';
import { DocumentAccessService } from './document-access.service';
import type { AddAclDto } from './dto/add-acl.dto';

/**
 * Manages per-document access-control grants (PM-0403). Every mutation is gated
 * by `document.write` (controller) PLUS document-level edit access (owner/Admin/
 * grant for confidential) and writes an `acl.changed` audit event.
 */
@Injectable()
export class DocumentAclService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: DocumentAccessService,
    private readonly audit: AuditService,
  ) {}

  /** Lists the grants on a document (management view). Requires edit access. */
  async list(documentId: string, user: AuthUser): Promise<AclGrant[]> {
    await this.assertManageable(documentId, user);
    const acls = await this.prisma.documentAcl.findMany({
      where: { documentId },
      orderBy: { createdAt: 'asc' },
      include: { createdBy: { select: { name: true } } },
    });
    return this.resolveNames(acls);
  }

  /** Adds a grant (idempotent for an identical principal+permission). */
  async add(
    documentId: string,
    dto: AddAclDto,
    user: AuthUser,
    ctx: RequestContext = {},
  ): Promise<AclGrant> {
    await this.assertManageable(documentId, user);
    await this.assertPrincipalExists(dto.principalType, dto.principalId);

    const existing = await this.prisma.documentAcl.findFirst({
      where: {
        documentId,
        principalType: dto.principalType,
        principalId: dto.principalId,
        permission: dto.permission,
      },
      include: { createdBy: { select: { name: true } } },
    });

    let acl = existing;
    let created = false;
    if (!existing) {
      try {
        acl = await this.prisma.documentAcl.create({
          data: {
            documentId,
            principalType: dto.principalType,
            principalId: dto.principalId,
            permission: dto.permission,
            createdById: user.id,
          },
          include: { createdBy: { select: { name: true } } },
        });
        created = true;
      } catch (err) {
        // FINDING-011: the findFirst-then-create pre-check is not race-safe on
        // its own — two concurrent add() calls for the same grant can both pass
        // it. The partial unique index (see schema.prisma) is the real backstop;
        // on a lost race, re-fetch and return the winner's row instead of
        // surfacing a raw P2002 to the caller (idempotent by design).
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          acl = await this.prisma.documentAcl.findFirst({
            where: {
              documentId,
              principalType: dto.principalType,
              principalId: dto.principalId,
              permission: dto.permission,
            },
            include: { createdBy: { select: { name: true } } },
          });
          if (!acl) throw err;
        } else {
          throw err;
        }
      }
    }

    if (created) {
      await this.audit.record({
        action: AUDIT_ACTIONS.ACL_CHANGED,
        actorUserId: user.id,
        documentId,
        targetType: 'document',
        ...ctx,
        metadata: {
          op: 'add',
          principalType: dto.principalType,
          principalId: dto.principalId,
          permission: dto.permission,
        },
      });
    }

    // Every path above either keeps `existing`, assigns a freshly created row,
    // or assigns the winner re-fetched after a P2002 (throwing if that also
    // comes back empty) — `acl` is always populated here.
    const [grant] = await this.resolveNames([acl as NonNullable<typeof acl>]);
    return grant;
  }

  /** Removes a grant by id (scoped to the document). Requires edit access. */
  async remove(
    documentId: string,
    aclId: string,
    user: AuthUser,
    ctx: RequestContext = {},
  ): Promise<void> {
    await this.assertManageable(documentId, user);
    const acl = await this.prisma.documentAcl.findFirst({
      where: { id: aclId, documentId },
      select: { id: true, principalType: true, principalId: true, permission: true },
    });
    if (!acl) throw new NotFoundException('Grant not found');

    await this.prisma.documentAcl.delete({ where: { id: acl.id } });
    await this.audit.record({
      action: AUDIT_ACTIONS.ACL_CHANGED,
      actorUserId: user.id,
      documentId,
      targetType: 'document',
      ...ctx,
      metadata: {
        op: 'remove',
        principalType: acl.principalType,
        principalId: acl.principalId,
        permission: acl.permission,
      },
    });
  }

  /** Loads the (active) document and asserts the caller may manage its access. */
  private async assertManageable(documentId: string, user: AuthUser): Promise<void> {
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, deletedAt: null },
      select: { id: true, ownerId: true, accessLevel: true, categoryId: true },
    });
    if (!doc) throw new NotFoundException('Document not found');
    await this.access.assertCanAccess(user, doc, 'edit');
  }

  private async assertPrincipalExists(type: 'role' | 'user', id: string): Promise<void> {
    if (type === 'role') {
      const role = await this.prisma.role.findUnique({ where: { id }, select: { id: true } });
      if (!role) throw new BadRequestException('Unknown roleId');
    } else {
      const target = await this.prisma.user.findUnique({ where: { id }, select: { id: true } });
      if (!target) throw new BadRequestException('Unknown userId');
    }
  }

  /**
   * Resolves human names for a batch of grants: role grants → role name, user
   * grants → user name. Batched to avoid an N+1 lookup.
   */
  private async resolveNames(
    acls: {
      id: string;
      documentId: string | null;
      categoryId: string | null;
      principalType: string;
      principalId: string;
      permission: string;
      createdAt: Date;
      createdBy: { name: string } | null;
    }[],
  ): Promise<AclGrant[]> {
    const roleIds = acls.filter((a) => a.principalType === 'role').map((a) => a.principalId);
    const userIds = acls.filter((a) => a.principalType === 'user').map((a) => a.principalId);
    const [roles, users] = await Promise.all([
      roleIds.length
        ? this.prisma.role.findMany({ where: { id: { in: roleIds } }, select: { id: true, name: true } })
        : Promise.resolve([]),
      userIds.length
        ? this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
        : Promise.resolve([]),
    ]);
    const roleName = new Map(roles.map((r) => [r.id, r.name]));
    const userName = new Map(users.map((u) => [u.id, u.name]));

    return acls.map((a) => ({
      id: a.id,
      documentId: a.documentId,
      categoryId: a.categoryId,
      principalType: a.principalType as AclGrant['principalType'],
      principalId: a.principalId,
      principalName:
        a.principalType === 'role'
          ? roleName.get(a.principalId) ?? null
          : userName.get(a.principalId) ?? null,
      permission: a.permission as AclGrant['permission'],
      createdAt: a.createdAt.toISOString(),
      createdByName: a.createdBy?.name ?? null,
    }));
  }
}
