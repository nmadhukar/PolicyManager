import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuditEventItem, AuditSource, Paginated } from '@policymanager/shared';
import { PrismaService } from '../prisma/prisma.service';

/** Everything needed to write one audit row. Only `action` is mandatory. */
export interface AuditRecordInput {
  action: string;
  actorUserId?: string | null;
  apiClientId?: string | null;
  targetType?: string | null;
  documentId?: string | null;
  versionId?: string | null;
  /** Origin of the action; defaults to `web`. */
  source?: AuditSource;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** Filters + pagination for the audit query API. */
export interface AuditQuery {
  actorUserId?: string;
  documentId?: string;
  action?: string;
  source?: AuditSource;
  /** Inclusive lower bound on createdAt (ISO). */
  from?: string;
  /** Inclusive upper bound on createdAt (ISO). */
  to?: string;
  page?: number;
  pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;

/**
 * Writes and reads the immutable audit trail (AGENTS.md §7/§8).
 *
 * Writes are deliberately fire-and-forget: {@link record} NEVER throws into the
 * request path — an audit outage must not break a document view or a login. The
 * failure is logged instead. There is intentionally no update/delete surface, so
 * audit rows cannot be mutated through normal app paths.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records an audit event. Resilient by contract: any failure (DB down, bad
   * input) is swallowed + logged, never propagated to the caller. Returns the new
   * row id on success, or null when the write was swallowed.
   */
  async record(input: AuditRecordInput): Promise<string | null> {
    try {
      const created = await this.prisma.auditEvent.create({
        data: {
          action: input.action,
          actorUserId: input.actorUserId ?? undefined,
          apiClientId: input.apiClientId ?? undefined,
          targetType: input.targetType ?? undefined,
          documentId: input.documentId ?? undefined,
          versionId: input.versionId ?? undefined,
          source: input.source ?? 'web',
          ipAddress: input.ipAddress ?? undefined,
          userAgent: input.userAgent ?? undefined,
          metadata:
            input.metadata != null
              ? (input.metadata as Prisma.InputJsonValue)
              : undefined,
        },
        select: { id: true },
      });
      return created.id;
    } catch (err) {
      // Best-effort: an audit failure must never surface to the user (AGENTS.md §8).
      this.logger.warn(
        `Failed to record audit event "${input.action}": ${(err as Error).message}`,
      );
      return null;
    }
  }

  /** Paginated, filtered, newest-first view of the audit trail. */
  async query(filters: AuditQuery): Promise<Paginated<AuditEventItem>> {
    const page = Math.max(Math.trunc(filters.page ?? 1), 1);
    const pageSize = Math.min(
      Math.max(Math.trunc(filters.pageSize ?? DEFAULT_PAGE_SIZE), 1),
      MAX_PAGE_SIZE,
    );

    const where = this.buildWhere(filters);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          actor: { select: { name: true, email: true } },
          document: { select: { title: true, documentNumber: true } },
        },
      }),
      this.prisma.auditEvent.count({ where }),
    ]);

    return {
      items: rows.map((r) => this.toItem(r)),
      total,
      page,
      pageSize,
    };
  }

  /** Translates validated filters into a Prisma where-clause (pure). */
  private buildWhere(filters: AuditQuery): Prisma.AuditEventWhereInput {
    const where: Prisma.AuditEventWhereInput = {};
    if (filters.actorUserId) where.actorUserId = filters.actorUserId;
    if (filters.documentId) where.documentId = filters.documentId;
    if (filters.action) where.action = filters.action;
    if (filters.source) where.source = filters.source;

    const from = parseDate(filters.from);
    const to = parseDate(filters.to);
    if (from || to) {
      where.createdAt = {
        ...(from ? { gte: from } : {}),
        ...(to ? { lte: to } : {}),
      };
    }
    return where;
  }

  private toItem(row: {
    id: string;
    action: string;
    source: string;
    targetType: string | null;
    documentId: string | null;
    versionId: string | null;
    actorUserId: string | null;
    ipAddress: string | null;
    userAgent: string | null;
    metadata: Prisma.JsonValue | null;
    createdAt: Date;
    actor: { name: string; email: string } | null;
    document: { title: string; documentNumber: string | null } | null;
  }): AuditEventItem {
    return {
      id: row.id,
      action: row.action,
      source: row.source as AuditSource,
      targetType: row.targetType,
      documentId: row.documentId,
      documentTitle: row.document?.title ?? null,
      documentNumber: row.document?.documentNumber ?? null,
      versionId: row.versionId,
      actorUserId: row.actorUserId,
      actorName: row.actor?.name ?? null,
      actorEmail: row.actor?.email ?? null,
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      metadata:
        row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
          ? (row.metadata as Record<string, unknown>)
          : null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

/** Parses an ISO date, returning undefined for missing/invalid input. */
function parseDate(value?: string): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
