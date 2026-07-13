import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AUDIT_ACTIONS,
  PERMISSIONS,
  ROLES,
  type AuthUser,
  type SavedSearchItem,
} from '@policymanager/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestContext } from '../audit/request-context';
import { PrismaService } from '../prisma/prisma.service';
import type { UpsertSavedSearchDto } from './dto/upsert-saved-search.dto';

const savedSearchInclude = {
  owner: { select: { name: true } },
} satisfies Prisma.SavedSearchInclude;

type SavedSearchRow = Prisma.SavedSearchGetPayload<{ include: typeof savedSearchInclude }>;

@Injectable()
export class SavedSearchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(user: AuthUser): Promise<SavedSearchItem[]> {
    const rows = await this.prisma.savedSearch.findMany({
      where: {
        OR: [
          { ownerId: user.id },
          { scope: 'global' },
          { scope: 'role', roleName: { in: user.roles } },
        ],
      },
      include: savedSearchInclude,
      orderBy: [{ scope: 'asc' }, { name: 'asc' }],
    });
    return rows.map(toItem);
  }

  async create(
    dto: UpsertSavedSearchDto,
    user: AuthUser,
    ctx: RequestContext = {},
  ): Promise<SavedSearchItem> {
    this.assertScope(dto, user);
    const row = await this.prisma.savedSearch.create({
      data: {
        name: dto.name.trim(),
        ownerId: user.id,
        scope: dto.scope ?? 'private',
        roleName: dto.scope === 'role' ? dto.roleName?.trim() || null : null,
        filters: dto.filters as Prisma.InputJsonValue,
        sort: dto.sort ? (dto.sort as Prisma.InputJsonValue) : undefined,
      },
      include: savedSearchInclude,
    });
    await this.audit.record({
      action: AUDIT_ACTIONS.SAVED_SEARCH_CREATED,
      actorUserId: user.id,
      targetType: 'saved_search',
      ...ctx,
      metadata: { savedSearchId: row.id, scope: row.scope },
    });
    return toItem(row);
  }

  async update(
    id: string,
    dto: UpsertSavedSearchDto,
    user: AuthUser,
    ctx: RequestContext = {},
  ): Promise<SavedSearchItem> {
    const existing = await this.loadForWrite(id, user);
    this.assertScope(dto, user);
    const row = await this.prisma.savedSearch.update({
      where: { id: existing.id },
      data: {
        name: dto.name.trim(),
        scope: dto.scope ?? 'private',
        roleName: dto.scope === 'role' ? dto.roleName?.trim() || null : null,
        filters: dto.filters as Prisma.InputJsonValue,
        sort: dto.sort ? (dto.sort as Prisma.InputJsonValue) : Prisma.DbNull,
      },
      include: savedSearchInclude,
    });
    await this.audit.record({
      action: AUDIT_ACTIONS.SAVED_SEARCH_UPDATED,
      actorUserId: user.id,
      targetType: 'saved_search',
      ...ctx,
      metadata: { savedSearchId: row.id, scope: row.scope },
    });
    return toItem(row);
  }

  async remove(id: string, user: AuthUser, ctx: RequestContext = {}): Promise<void> {
    const existing = await this.loadForWrite(id, user);
    await this.prisma.savedSearch.delete({ where: { id: existing.id } });
    await this.audit.record({
      action: AUDIT_ACTIONS.SAVED_SEARCH_DELETED,
      actorUserId: user.id,
      targetType: 'saved_search',
      ...ctx,
      metadata: { savedSearchId: id, scope: existing.scope },
    });
  }

  async markRun(id: string, user: AuthUser): Promise<SavedSearchItem> {
    const existing = await this.prisma.savedSearch.findFirst({
      where: {
        id,
        OR: [
          { ownerId: user.id },
          { scope: 'global' },
          { scope: 'role', roleName: { in: user.roles } },
        ],
      },
      include: savedSearchInclude,
    });
    if (!existing) throw new NotFoundException('Saved search not found');
    const row = await this.prisma.savedSearch.update({
      where: { id },
      data: { lastRunAt: new Date() },
      include: savedSearchInclude,
    });
    return toItem(row);
  }

  private assertScope(dto: UpsertSavedSearchDto, user: AuthUser): void {
    const scope = dto.scope ?? 'private';
    if (scope === 'private') return;
    const canShare =
      user.permissions.includes(PERMISSIONS.SAVED_SEARCH_MANAGE) || user.roles.includes(ROLES.ADMIN);
    if (!canShare) throw new ForbiddenException('Shared saved searches require saved_search.manage');
    if (scope === 'role' && !dto.roleName?.trim()) {
      throw new BadRequestException('roleName is required for role-scoped searches');
    }
  }

  private async loadForWrite(id: string, user: AuthUser) {
    const row = await this.prisma.savedSearch.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Saved search not found');
    const owns = row.ownerId === user.id;
    const canShare =
      user.permissions.includes(PERMISSIONS.SAVED_SEARCH_MANAGE) || user.roles.includes(ROLES.ADMIN);
    if (!owns && !canShare) throw new ForbiddenException('You cannot change this saved search');
    return row;
  }
}

function toItem(row: SavedSearchRow): SavedSearchItem {
  return {
    id: row.id,
    name: row.name,
    ownerId: row.ownerId,
    ownerName: row.owner?.name ?? null,
    scope: row.scope,
    roleName: row.roleName,
    filters: safeObject(row.filters),
    sort: row.sort ? safeObject(row.sort) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastRunAt: row.lastRunAt ? row.lastRunAt.toISOString() : null,
  };
}

function safeObject(value: Prisma.JsonValue): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
