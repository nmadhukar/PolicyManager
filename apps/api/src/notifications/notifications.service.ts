import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  APP_NOTIFICATION_LABELS,
  APP_NOTIFICATION_TYPES,
  AUDIT_ACTIONS,
  PERMISSIONS,
  ROLES,
  type AppNotificationType,
  type AuthUser,
  type NotificationDigestRunResult,
  type NotificationItem,
  type NotificationPreferenceView,
  type NotificationPriority,
  type Paginated,
} from '@policymanager/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestContext } from '../audit/request-context';
import { mapWithConcurrency } from '../common/concurrency.util';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import type { ListNotificationsQueryDto } from './dto/list-notifications-query.dto';
import type { UpdateNotificationPreferencesDto } from './dto/update-notification-preferences.dto';

interface CreateNotificationInput {
  recipientId: string;
  actorId?: string | null;
  type: AppNotificationType;
  title: string;
  body: string;
  entityType?: string | null;
  entityId?: string | null;
  documentId?: string | null;
  documentVersionId?: string | null;
  priority?: NotificationPriority;
  metadata?: Record<string, unknown> | null;
  dedupeKey?: string | null;
}

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

/** Cap on concurrent digest sends, mirroring the import pipeline's bound (ImportsService). */
const DIGEST_CONCURRENCY = 8;

const notificationInclude = {
  actor: { select: { name: true } },
} satisfies Prisma.NotificationInclude;

type NotificationRow = Prisma.NotificationGetPayload<{ include: typeof notificationInclude }>;

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
  ) {}

  async create(input: CreateNotificationInput): Promise<void> {
    const recipient = await this.prisma.user.findUnique({
      where: { id: input.recipientId },
      select: { id: true, status: true },
    });
    if (!recipient || recipient.status !== 'active') return;

    const prefs = await this.ensurePreferences(input.recipientId);
    if (!prefs.inAppEnabled && !prefs.emailDigestEnabled) return;
    if (!typeEnabled(prefs, input.type, 'inApp') && !typeEnabled(prefs, input.type, 'emailDigest')) return;

    try {
      await this.prisma.notification.create({
        data: {
          recipientId: input.recipientId,
          actorId: input.actorId ?? undefined,
          type: input.type,
          title: input.title,
          body: input.body,
          entityType: input.entityType ?? undefined,
          entityId: input.entityId ?? undefined,
          documentId: input.documentId ?? undefined,
          documentVersionId: input.documentVersionId ?? undefined,
          priority: input.priority ?? 'normal',
          metadata: input.metadata ? (input.metadata as Prisma.InputJsonValue) : undefined,
          dedupeKey: input.dedupeKey ?? undefined,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return;
      this.logger.warn(`Failed to create notification: ${(err as Error).message}`);
    }
  }

  async list(
    user: AuthUser,
    query: ListNotificationsQueryDto,
  ): Promise<Paginated<NotificationItem>> {
    const page = Math.max(Math.trunc(query.page ?? 1), 1);
    const pageSize = Math.min(Math.max(Math.trunc(query.pageSize ?? DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);
    // Honor the in-app preference: nothing shows if in-app is off, and per-type
    // `inApp:false` overrides are hidden from the feed (they may still be created
    // for the email digest). Only EXPIRED notifications are hidden (future-dated stay).
    const prefs = await this.ensurePreferences(user.id);
    if (!prefs.inAppEnabled) {
      return { items: [], total: 0, page, pageSize };
    }
    const hiddenInApp = APP_NOTIFICATION_TYPES.filter((t) => !typeEnabled(prefs, t, 'inApp'));
    const where: Prisma.NotificationWhereInput = {
      recipientId: user.id,
      dismissedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      ...(hiddenInApp.length ? { type: { notIn: hiddenInApp } } : {}),
      ...(query.unreadOnly ? { readAt: null } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where,
        include: notificationInclude,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.notification.count({ where }),
    ]);
    // FINDING-004: resolve linked-document visibility for the WHOLE page in a
    // small constant number of queries instead of one canSeeLinkedDocument()
    // chain per row (up to 3 sequential DB calls per row previously).
    const documentIds = Array.from(
      new Set(rows.map((r) => r.documentId).filter((id): id is string => !!id)),
    );
    const visibility = await this.resolveDocumentVisibility(user, documentIds);
    const items = rows.map((row) => this.toItem(row, visibility));
    return { items, total, page, pageSize };
  }

  async unreadCount(user: AuthUser): Promise<{ unread: number }> {
    // Mirror `list`'s in-app preference + expiry filter so the badge count can't
    // diverge from the visible feed.
    const prefs = await this.ensurePreferences(user.id);
    if (!prefs.inAppEnabled) return { unread: 0 };
    const hiddenInApp = APP_NOTIFICATION_TYPES.filter((t) => !typeEnabled(prefs, t, 'inApp'));
    const unread = await this.prisma.notification.count({
      where: {
        recipientId: user.id,
        readAt: null,
        dismissedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        ...(hiddenInApp.length ? { type: { notIn: hiddenInApp } } : {}),
      },
    });
    return { unread };
  }

  async markRead(id: string, user: AuthUser): Promise<NotificationItem> {
    await this.assertOwns(id, user.id);
    const row = await this.prisma.notification.update({
      where: { id },
      data: { readAt: new Date() },
      include: notificationInclude,
    });
    const visibility = await this.resolveDocumentVisibility(
      user,
      row.documentId ? [row.documentId] : [],
    );
    return this.toItem(row, visibility);
  }

  async readAll(user: AuthUser): Promise<{ updated: number }> {
    const result = await this.prisma.notification.updateMany({
      where: { recipientId: user.id, readAt: null, dismissedAt: null },
      data: { readAt: new Date() },
    });
    return { updated: result.count };
  }

  async dismiss(id: string, user: AuthUser): Promise<void> {
    await this.assertOwns(id, user.id);
    await this.prisma.notification.update({ where: { id }, data: { dismissedAt: new Date() } });
  }

  async getPreferences(user: AuthUser): Promise<NotificationPreferenceView> {
    return toPreferenceView(await this.ensurePreferences(user.id));
  }

  async updatePreferences(
    dto: UpdateNotificationPreferencesDto,
    user: AuthUser,
    ctx: RequestContext = {},
  ): Promise<NotificationPreferenceView> {
    const row = await this.prisma.notificationPreference.upsert({
      where: { userId: user.id },
      update: {
        inAppEnabled: dto.inAppEnabled,
        emailDigestEnabled: dto.emailDigestEnabled,
        digestFrequency: dto.digestFrequency,
        digestTimeLocal: dto.digestTimeLocal,
        timezone: dto.timezone,
        typeOverrides: dto.typeOverrides ? (dto.typeOverrides as Prisma.InputJsonValue) : undefined,
      },
      create: {
        userId: user.id,
        inAppEnabled: dto.inAppEnabled ?? true,
        emailDigestEnabled: dto.emailDigestEnabled ?? false,
        digestFrequency: dto.digestFrequency ?? 'daily',
        digestTimeLocal: dto.digestTimeLocal ?? '08:00',
        timezone: dto.timezone ?? 'America/New_York',
        typeOverrides: dto.typeOverrides ? (dto.typeOverrides as Prisma.InputJsonValue) : undefined,
      },
    });
    await this.audit.record({
      action: AUDIT_ACTIONS.NOTIFICATION_PREFERENCES_UPDATED,
      actorUserId: user.id,
      targetType: 'notification_preferences',
      ...ctx,
    });
    return toPreferenceView(row);
  }

  async runDigest(now: Date = new Date(), force = false): Promise<NotificationDigestRunResult> {
    const prefs = await this.prisma.notificationPreference.findMany({
      where: { emailDigestEnabled: true },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            status: true,
            roles: {
              select: {
                role: {
                  select: {
                    name: true,
                    permissions: { select: { permission: { select: { key: true } } } },
                  },
                },
              },
            },
          },
        },
      },
    });
    let sent = 0;
    let failed = 0;
    // Each user's digest is independent (own DB rows, own mail send, own watermark
    // update), so the sweep fans out with a bounded worker pool instead of sending
    // one digest at a time — mirrors ImportsService's mapWithConcurrency pattern.
    const outcomes = await mapWithConcurrency(prefs, DIGEST_CONCURRENCY, async (pref) => {
      if (pref.user.status !== 'active' || (!force && !shouldSend(pref, now))) return null;
      // Isolate each user: one user's send/DB error must never abort the sweep and
      // starve every other user of their digest.
      try {
        const since = pref.lastDigestSentAt ?? windowStart(pref.digestFrequency, now);
        const rows = await this.prisma.notification.findMany({
          where: {
            recipientId: pref.userId,
            dismissedAt: null,
            createdAt: { gt: since, lte: now },
          },
          orderBy: { createdAt: 'desc' },
          take: 25,
        });
        const digestRows = rows.filter((row) =>
          typeEnabled(pref, row.type as AppNotificationType, 'emailDigest'),
        );
        const digestUser = authUserFromPreference(pref.user);
        // FINDING-009: resolve linked-document visibility for this user's WHOLE
        // digest batch in one bounded set of queries, mirroring list()'s fix
        // (FINDING-004) — a per-row canSeeLinkedDocument() call here re-ran the
        // same document/role/ACL lookup chain once per digest row.
        const documentIds = Array.from(
          new Set(digestRows.map((r) => r.documentId).filter((id): id is string => !!id)),
        );
        const visibility = await this.resolveDocumentVisibility(digestUser, documentIds);
        const visibleRows = digestRows.filter(
          (row) => row.documentId === null || (visibility.get(row.documentId) ?? false),
        );
        if (visibleRows.length === 0) return null;
        const subject = `PolicyManager digest: ${visibleRows.length} update${visibleRows.length === 1 ? '' : 's'}`;
        const html = renderDigest(pref.user.name, visibleRows);
        const ok = await this.mail.send(
          { to: pref.user.email, subject, html },
          { type: 'other', toUserId: pref.userId },
        );
        // On success advance the dedup watermark FIRST, so a later failure writing the
        // delivery/audit row can't leave `lastDigestSentAt` stale and cause a re-send.
        if (ok) {
          await this.prisma.notificationPreference.update({
            where: { userId: pref.userId },
            data: { lastDigestSentAt: now },
          });
        }
        await this.prisma.notificationDelivery.create({
          data: {
            recipientId: pref.userId,
            channel: 'email_digest',
            status: ok ? 'sent' : 'failed',
            subject,
            sentAt: ok ? now : undefined,
            errorMessage: ok ? undefined : 'MailService returned false',
            metadata: { count: visibleRows.length } as Prisma.InputJsonValue,
          },
        });
        await this.audit.record({
          action: ok ? AUDIT_ACTIONS.NOTIFICATION_DIGEST_SENT : AUDIT_ACTIONS.NOTIFICATION_DIGEST_FAILED,
          actorUserId: pref.userId,
          source: 'system',
          targetType: 'notification_digest',
          metadata: { count: visibleRows.length },
        });
        return ok ? 'sent' : 'failed';
      } catch (err) {
        this.logger.warn(`Digest failed for user ${pref.userId}: ${(err as Error).message}`);
        return 'failed';
      }
    });
    for (const outcome of outcomes) {
      if (outcome === 'sent') sent += 1;
      else if (outcome === 'failed') failed += 1;
    }
    return { usersConsidered: prefs.length, digestsSent: sent, failed };
  }

  async notifyApprovalRequested(documentId: string, actor: AuthUser): Promise<void> {
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, deletedAt: null },
      select: { id: true, title: true, currentVersionId: true },
    });
    if (!doc) return;
    const approvers = await this.usersWithPermission(PERMISSIONS.DOCUMENT_APPROVE);
    await Promise.all(
      approvers
        .filter((u) => u.id !== actor.id)
        .map((u) =>
          this.create({
            recipientId: u.id,
            actorId: actor.id,
            type: 'approval_requested',
            title: 'Approval requested',
            body: doc.title,
            documentId,
            documentVersionId: doc.currentVersionId,
            entityType: 'document',
            entityId: documentId,
            priority: 'high',
            dedupeKey: `approval:${documentId}:${doc.currentVersionId ?? 'none'}:${u.id}`,
          }),
        ),
    );
  }

  async notifyPolicyPublished(documentId: string, versionId: string, actor: AuthUser): Promise<void> {
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, deletedAt: null },
      select: {
        title: true,
        ownerId: true,
        reviewAssignments: { select: { reviewerId: true } },
        acknowledgmentAssignments: { where: { versionId }, select: { assigneeId: true } },
      },
    });
    if (!doc) return;
    const ids = new Set<string>([doc.ownerId]);
    doc.reviewAssignments.forEach((r) => ids.add(r.reviewerId));
    doc.acknowledgmentAssignments.forEach((a) => ids.add(a.assigneeId));
    ids.delete(actor.id);
    await Promise.all(
      [...ids].map((recipientId) =>
        this.create({
          recipientId,
          actorId: actor.id,
          type: 'policy_published',
          title: 'Policy published',
          body: doc.title,
          documentId,
          documentVersionId: versionId,
          entityType: 'document',
          entityId: documentId,
          dedupeKey: `published:${documentId}:${versionId}:${recipientId}`,
        }),
      ),
    );
  }

  async notifyReviewTaskCreated(taskId: string): Promise<void> {
    const task = await this.prisma.reviewTask.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        assignedToId: true,
        documentId: true,
        versionId: true,
        dueDate: true,
        document: { select: { title: true } },
      },
    });
    if (!task) return;
    await this.create({
      recipientId: task.assignedToId,
      type: 'review_assigned',
      title: 'Review assigned',
      body: `${task.document.title} is due ${formatDate(task.dueDate)}.`,
      documentId: task.documentId,
      documentVersionId: task.versionId,
      entityType: 'review_task',
      entityId: task.id,
      priority: task.dueDate.getTime() < Date.now() ? 'high' : 'normal',
      dedupeKey: `review-task:${task.id}`,
    });
  }

  async notifyAcknowledgmentAssignment(assignmentId: string): Promise<void> {
    const assignment = await this.prisma.acknowledgmentAssignment.findUnique({
      where: { id: assignmentId },
      select: {
        id: true,
        assigneeId: true,
        documentId: true,
        versionId: true,
        dueDate: true,
        document: { select: { title: true } },
      },
    });
    if (!assignment) return;
    await this.create({
      recipientId: assignment.assigneeId,
      type: 'acknowledgment_due',
      title: 'Acknowledgment due',
      body: `${assignment.document.title}${assignment.dueDate ? ` is due ${formatDate(assignment.dueDate)}` : ''}.`,
      documentId: assignment.documentId,
      documentVersionId: assignment.versionId,
      entityType: 'acknowledgment_assignment',
      entityId: assignment.id,
      priority: assignment.dueDate && assignment.dueDate.getTime() < Date.now() ? 'high' : 'normal',
      dedupeKey: `ack:${assignment.id}`,
    });
  }

  async notifyCommentResolved(annotationId: string, actor: AuthUser): Promise<void> {
    const row = await this.prisma.documentAnnotation.findUnique({
      where: { id: annotationId },
      select: {
        id: true,
        authorId: true,
        documentId: true,
        versionId: true,
        document: { select: { title: true } },
      },
    });
    if (!row || row.authorId === actor.id) return;
    await this.create({
      recipientId: row.authorId,
      actorId: actor.id,
      type: 'comment_resolved',
      title: 'Comment resolved',
      body: row.document.title,
      documentId: row.documentId,
      documentVersionId: row.versionId,
      entityType: 'annotation',
      entityId: row.id,
      dedupeKey: `comment-resolved:${row.id}:${actor.id}`,
    });
  }

  private async usersWithPermission(permission: string) {
    return this.prisma.user.findMany({
      where: {
        status: 'active',
        roles: { some: { role: { permissions: { some: { permission: { key: permission } } } } } },
      },
      select: { id: true },
    });
  }

  private async ensurePreferences(userId: string) {
    return this.prisma.notificationPreference.upsert({
      where: { userId },
      update: {},
      create: { userId },
    });
  }

  private async assertOwns(id: string, userId: string): Promise<void> {
    const count = await this.prisma.notification.count({ where: { id, recipientId: userId } });
    if (count === 0) throw new NotFoundException('Notification not found');
  }

  /** Projects a row using a pre-resolved per-documentId visibility map (see {@link resolveDocumentVisibility}). */
  private toItem(row: NotificationRow, visibility: Map<string, boolean>): NotificationItem {
    const canSee = row.documentId === null || (visibility.get(row.documentId) ?? false);
    const metadata = objectOrNull(row.metadata);
    return {
      id: row.id,
      type: row.type as AppNotificationType,
      title: canSee ? row.title : 'Document unavailable',
      body: canSee ? row.body : 'You no longer have access to the linked document.',
      priority: row.priority as NotificationPriority,
      entityType: row.entityType,
      entityId: row.entityId,
      documentId: row.documentId,
      documentVersionId: row.documentVersionId,
      href: canSee ? hrefFor(row.type as AppNotificationType, row.documentId) : null,
      metadata: canSee ? metadata : null,
      readAt: row.readAt ? row.readAt.toISOString() : null,
      dismissedAt: row.dismissedAt ? row.dismissedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      actorName: row.actor?.name ?? null,
    };
  }

  /**
   * FINDING-004: resolves whether `user` may see each of `documentIds` in ONE
   * bounded set of queries — a batch fetch of the documents, then (only if any
   * are confidential) a single role lookup and a single ACL grant lookup — instead
   * of the previous per-document chain (document lookup + role lookup + ACL count,
   * up to 3 sequential round-trips EACH). The visibility decision per document is
   * identical to the prior canSeeLinkedDocument logic.
   */
  private async resolveDocumentVisibility(
    user: AuthUser,
    documentIds: string[],
  ): Promise<Map<string, boolean>> {
    const visibility = new Map<string, boolean>();
    if (documentIds.length === 0) return visibility;
    if (!user.permissions.includes(PERMISSIONS.DOCUMENT_READ)) {
      documentIds.forEach((id) => visibility.set(id, false));
      return visibility;
    }

    const docs = await this.prisma.document.findMany({
      where: { id: { in: documentIds }, deletedAt: null },
      select: { id: true, ownerId: true, accessLevel: true, categoryId: true },
    });
    const docById = new Map(docs.map((d) => [d.id, d]));

    const isAdmin = user.roles.includes(ROLES.ADMIN);
    const confidential = docs.filter(
      (d) => d.accessLevel === 'confidential' && !isAdmin && d.ownerId !== user.id,
    );

    let grantedDocumentIds = new Set<string>();
    let grantedCategoryIds = new Set<string>();
    if (confidential.length > 0) {
      const roles = await this.prisma.role.findMany({
        where: { name: { in: user.roles } },
        select: { id: true },
      });
      const roleIds = roles.map((r) => r.id);
      const categoryIds = confidential
        .map((d) => d.categoryId)
        .filter((id): id is string => !!id);
      const grants = await this.prisma.documentAcl.findMany({
        where: {
          AND: [
            {
              OR: [
                { documentId: { in: confidential.map((d) => d.id) } },
                ...(categoryIds.length ? [{ categoryId: { in: categoryIds } }] : []),
              ],
            },
            {
              OR: [
                { principalType: 'user', principalId: user.id },
                { principalType: 'role', principalId: { in: roleIds } },
              ],
            },
          ],
        },
        select: { documentId: true, categoryId: true },
      });
      grantedDocumentIds = new Set(
        grants.map((g) => g.documentId).filter((id): id is string => !!id),
      );
      grantedCategoryIds = new Set(
        grants.map((g) => g.categoryId).filter((id): id is string => !!id),
      );
    }

    for (const id of documentIds) {
      const doc = docById.get(id);
      if (!doc) {
        visibility.set(id, false);
        continue;
      }
      if (doc.accessLevel !== 'confidential' || isAdmin || doc.ownerId === user.id) {
        visibility.set(id, true);
        continue;
      }
      visibility.set(
        id,
        grantedDocumentIds.has(id) || (!!doc.categoryId && grantedCategoryIds.has(doc.categoryId)),
      );
    }
    return visibility;
  }
}

function toPreferenceView(row: {
  inAppEnabled: boolean;
  emailDigestEnabled: boolean;
  digestFrequency: string;
  digestTimeLocal: string;
  timezone: string;
  typeOverrides: Prisma.JsonValue | null;
  lastDigestSentAt: Date | null;
}): NotificationPreferenceView {
  return {
    inAppEnabled: row.inAppEnabled,
    emailDigestEnabled: row.emailDigestEnabled,
    digestFrequency: row.digestFrequency as NotificationPreferenceView['digestFrequency'],
    digestTimeLocal: row.digestTimeLocal,
    timezone: row.timezone,
    typeOverrides: objectOrNull(row.typeOverrides) ?? {},
    lastDigestSentAt: row.lastDigestSentAt ? row.lastDigestSentAt.toISOString() : null,
  };
}

function authUserFromPreference(user: {
  id: string;
  email: string;
  name: string;
  roles: Array<{
    role: {
      name: string;
      permissions: Array<{ permission: { key: string } }>;
    };
  }>;
}): AuthUser {
  const roles = user.roles.map((entry) => entry.role.name);
  const permissions = new Set<string>();
  user.roles.forEach((entry) =>
    entry.role.permissions.forEach((permission) => permissions.add(permission.permission.key)),
  );
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    roles,
    permissions: [...permissions],
    mustChangePassword: false,
  };
}

function typeEnabled(
  pref: { typeOverrides: Prisma.JsonValue | null },
  type: AppNotificationType,
  channel: 'inApp' | 'emailDigest',
): boolean {
  const overrides = objectOrNull(pref.typeOverrides);
  const entry = overrides?.[type];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return true;
  const value = (entry as Record<string, unknown>)[channel];
  return typeof value === 'boolean' ? value : true;
}

function hrefFor(type: AppNotificationType, documentId: string | null): string | null {
  if (type === 'review_assigned') return '/reviews';
  if (type === 'acknowledgment_due') return '/acknowledgments';
  if (!documentId) return null;
  return `/library/${documentId}`;
}

function objectOrNull(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function renderDigest(name: string, rows: { type: string; title: string; body: string }[]): string {
  const items = rows
    .map(
      (row) =>
        `<li><strong>${escapeHtml(APP_NOTIFICATION_LABELS[row.type as AppNotificationType] ?? row.title)}</strong>: ${escapeHtml(row.body)}</li>`,
    )
    .join('');
  return `<p>Hi ${escapeHtml(name || 'there')},</p><p>Your PolicyManager updates:</p><ul>${items}</ul><p>Sign in to PolicyManager to take action.</p>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function windowStart(frequency: string, now: Date): Date {
  const d = new Date(now);
  d.setDate(d.getDate() - (frequency === 'weekly' ? 7 : 1));
  return d;
}

function shouldSend(
  pref: { digestFrequency: string; digestTimeLocal: string; timezone: string; lastDigestSentAt: Date | null },
  now: Date,
): boolean {
  const localHour = new Intl.DateTimeFormat('en-US', {
    timeZone: pref.timezone || 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
  if (localHour.slice(0, 2) !== pref.digestTimeLocal.slice(0, 2)) return false;
  if (!pref.lastDigestSentAt) return true;
  const minMs = pref.digestFrequency === 'weekly' ? 6 * 24 * 60 * 60 * 1000 : 20 * 60 * 60 * 1000;
  return now.getTime() - pref.lastDigestSentAt.getTime() >= minMs;
}
