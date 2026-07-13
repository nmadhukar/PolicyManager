import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
  AUDIT_ACTIONS,
  DEFAULT_REVIEW_LEAD_DAYS,
  OPEN_REVIEW_TASK_STATUSES,
  PERMISSIONS,
  type AuthUser,
  type ComplianceSummary,
  type CompleteReviewInput,
  type Paginated,
  type ReviewSweepResult,
  type ReviewTaskItem,
  type ReviewTaskStatus,
  type ReviewerAssignment,
} from '@policymanager/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { RequestContext } from '../audit/request-context';
import { MailService } from '../mail/mail.service';
import { AttestationService } from '../attestation/attestation.service';
import { AcknowledgmentService } from '../attestation/acknowledgment.service';
import { NotificationsService } from '../notifications/notifications.service';
import { addDays, advanceReviewDate } from './review-cadence.util';

/** Filters for the review-task listing (already validated in the DTO). */
export interface ListReviewsQuery {
  assignedToId?: string;
  documentId?: string;
  status?: ReviewTaskStatus;
  dueFrom?: string;
  dueTo?: string;
  mine?: boolean;
  page?: number;
  pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;

/** Document lifecycle states excluded from review scheduling + compliance. */
const INACTIVE_STATUSES: Prisma.DocumentWhereInput['status'] = { notIn: ['archived', 'retired'] };

/** Task fields + joins needed to build a {@link ReviewTaskItem}. */
const taskInclude = {
  // currentVersionId lets completion attach the sign-off to the exact version.
  document: {
    select: { title: true, documentNumber: true, reviewCadence: true, currentVersionId: true },
  },
  assignedTo: { select: { name: true } },
  completedBy: { select: { name: true } },
} satisfies Prisma.ReviewTaskInclude;

type TaskWithJoins = Prisma.ReviewTaskGetPayload<{ include: typeof taskInclude }>;

/**
 * QC review scheduling + sign-off (Phase 5, PM-0501..PM-0506).
 *
 * Responsibilities:
 *  - reviewer assignment per document (many reviewers),
 *  - the daily sweep ({@link runReviewSweep}, clock-injected) that raises tasks for
 *    documents coming due and marks past-due tasks overdue — idempotent, so it never
 *    double-creates an open task,
 *  - review completion that advances the document's nextReviewDate by cadence,
 *  - task listing/detail (own-tasks scoping for non-managers) and the compliance
 *    summary.
 *
 * Attestation (Phase 6) will hang off a completed task via `reviewTaskId`; the
 * completion path leaves a clean seam for it (see {@link completeTask}).
 */
@Injectable()
export class ReviewService {
  private readonly logger = new Logger(ReviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly attestation: AttestationService,
    private readonly acknowledgment: AcknowledgmentService,
    private readonly notifications?: NotificationsService,
  ) {}

  // ---- Reviewer assignment -------------------------------------------------

  /** Assigns `reviewerId` to a document's review cycle (idempotent per pair). */
  async assignReviewer(
    documentId: string,
    reviewerId: string,
    actor: AuthUser,
    ctx: RequestContext = {},
  ): Promise<ReviewerAssignment> {
    await this.assertActiveDocument(documentId);
    const reviewer = await this.prisma.user.findUnique({
      where: { id: reviewerId },
      select: { id: true, name: true, email: true },
    });
    if (!reviewer) throw new BadRequestException('Unknown reviewer userId');

    const existing = await this.prisma.reviewAssignment.findUnique({
      where: { documentId_reviewerId: { documentId, reviewerId } },
    });
    const assignment =
      existing ??
      (await this.prisma.reviewAssignment.create({
        data: { documentId, reviewerId, createdById: actor.id },
      }));

    if (!existing) {
      await this.audit.record({
        action: AUDIT_ACTIONS.REVIEW_ASSIGNED,
        actorUserId: actor.id,
        documentId,
        targetType: 'document',
        ...ctx,
        metadata: { op: 'add', reviewerId },
      });
      if (this.notifications) {
        const doc = await this.prisma.document.findUnique({
          where: { id: documentId },
          select: { title: true, currentVersionId: true },
        });
        await this.notifications.create({
          recipientId: reviewerId,
          actorId: actor.id,
          type: 'review_assigned',
          title: 'Review assigned',
          body: doc?.title ?? 'Document review',
          documentId,
          documentVersionId: doc?.currentVersionId ?? null,
          entityType: 'review_assignment',
          entityId: assignment.id,
          dedupeKey: `review-assignment:${assignment.id}`,
        });
      }
    }

    return {
      userId: reviewer.id,
      name: reviewer.name,
      email: reviewer.email,
      assignedAt: assignment.createdAt.toISOString(),
    };
  }

  /** Removes a reviewer assignment. 404 if the pair is not assigned. */
  async unassignReviewer(
    documentId: string,
    reviewerId: string,
    actor: AuthUser,
    ctx: RequestContext = {},
  ): Promise<void> {
    const existing = await this.prisma.reviewAssignment.findUnique({
      where: { documentId_reviewerId: { documentId, reviewerId } },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Reviewer assignment not found');

    await this.prisma.reviewAssignment.delete({ where: { id: existing.id } });
    await this.audit.record({
      action: AUDIT_ACTIONS.REVIEW_ASSIGNED,
      actorUserId: actor.id,
      documentId,
      targetType: 'document',
      ...ctx,
      metadata: { op: 'remove', reviewerId },
    });
  }

  /** Lists a document's assigned reviewers (management view). */
  async listReviewers(documentId: string): Promise<ReviewerAssignment[]> {
    await this.assertActiveDocument(documentId);
    const rows = await this.prisma.reviewAssignment.findMany({
      where: { documentId },
      include: { reviewer: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      userId: r.reviewer.id,
      name: r.reviewer.name,
      email: r.reviewer.email,
      assignedAt: r.createdAt.toISOString(),
    }));
  }

  // ---- Daily sweep ---------------------------------------------------------

  /**
   * Generates review tasks for documents coming due and marks past-due tasks
   * overdue. Injectable/clock-injected: `now` is a parameter so the cron, the
   * manual trigger, and tests all drive it deterministically (AGENTS.md §6).
   *
   * A document is "coming due" when it is active (not deleted/archived/retired),
   * has a `nextReviewDate <= now + leadTime`, and has NO open task — the last check
   * makes the sweep idempotent (re-running never double-creates an open task). Tasks
   * are raised for each assigned reviewer, falling back to the document owner when
   * there are none. Every reviewer is emailed (best-effort) and each task is audited.
   */
  async runReviewSweep(
    now: Date,
    leadTimeDays: number = DEFAULT_REVIEW_LEAD_DAYS,
  ): Promise<ReviewSweepResult> {
    const dueThreshold = addDays(now, leadTimeDays);

    const docs = await this.prisma.document.findMany({
      where: {
        deletedAt: null,
        status: INACTIVE_STATUSES,
        nextReviewDate: { not: null, lte: dueThreshold },
        // No OPEN task already exists for the document — the idempotency guard.
        reviewTasks: { none: { status: { in: [...OPEN_REVIEW_TASK_STATUSES] } } },
      },
      select: {
        id: true,
        title: true,
        nextReviewDate: true,
        currentVersionId: true,
        owner: { select: { id: true, name: true, email: true } },
        reviewAssignments: {
          select: { reviewer: { select: { id: true, name: true, email: true } } },
        },
      },
    });

    const appUrl = this.appUrl();
    let tasksCreated = 0;

    for (const doc of docs) {
      const due = doc.nextReviewDate as Date; // guaranteed non-null by the where-clause
      const reviewers =
        doc.reviewAssignments.length > 0
          ? doc.reviewAssignments.map((a) => a.reviewer)
          : [doc.owner];

      for (const reviewer of reviewers) {
        // C2/D9: the `reviewTasks: { none: open }` guard above makes the sweep
        // idempotent, but two concurrent sweeps could still both pass it. The
        // partial unique index on OPEN (documentId, assignedToId) is the real
        // backstop — a lost race surfaces as P2002, which we treat as "already
        // created" and skip rather than crashing the whole sweep.
        let task: { id: string };
        try {
          task = await this.prisma.reviewTask.create({
            data: {
              documentId: doc.id,
              versionId: doc.currentVersionId ?? undefined,
              dueDate: due,
              assignedToId: reviewer.id,
              status: 'pending',
            },
            select: { id: true },
          });
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            continue; // an open task for this (doc, reviewer) already exists
          }
          throw err;
        }
        tasksCreated += 1;

        await this.audit.record({
          action: AUDIT_ACTIONS.REVIEW_TASK_CREATED,
          documentId: doc.id,
          versionId: doc.currentVersionId ?? undefined,
          targetType: 'review_task',
          source: 'system',
          metadata: { taskId: task.id, assignedToId: reviewer.id, dueDate: due.toISOString() },
        });

        // Best-effort reminder — MailService never throws and logs the outcome.
        await this.notifications?.notifyReviewTaskCreated(task.id);
        await this.mail.sendReviewReminder({
          to: reviewer.email,
          name: reviewer.name,
          documentTitle: doc.title,
          dueDate: due,
          reviewUrl: `${appUrl}/library/${doc.id}`,
          overdue: due.getTime() < now.getTime(),
          toUserId: reviewer.id,
          reviewTaskId: task.id,
        });
      }
    }

    // Flip any still-open, past-due tasks (including freshly-created ones for docs
    // already past their date) to `overdue` — but ONLY for documents still in active
    // circulation (C8), so a soft-deleted/archived/retired doc's tasks are not revived.
    const overdue = await this.prisma.reviewTask.updateMany({
      where: {
        status: { in: ['pending', 'in_progress'] },
        dueDate: { lt: now },
        document: { deletedAt: null, status: INACTIVE_STATUSES },
      },
      data: { status: 'overdue' },
    });

    // Phase 6: also flip past-due staff acknowledgment assignments to overdue.
    const acksOverdue = await this.acknowledgment.markOverdue(now);

    this.logger.log(
      `Sweep: considered ${docs.length} due docs, created ${tasksCreated} tasks, ` +
        `marked ${overdue.count} review tasks + ${acksOverdue} acknowledgments overdue`,
    );
    return { tasksCreated, overdueMarked: overdue.count, documentsConsidered: docs.length };
  }

  // ---- Completion ----------------------------------------------------------

  /**
   * Completes a review task and advances the document's nextReviewDate by cadence
   * (quarterly +3mo, annual +12mo, custom/none require `newNextReviewDate`).
   * Authorized for the task's assignee OR a `review.manage` holder. `now` is
   * injected for testable, deterministic date math.
   *
   * Phase 6 (seam filled): completion records an IMMUTABLE `reviewed`
   * {@link Attestation} (name + role + timestamp + IP), linked to this task via
   * `reviewTaskId` and to the version under review. `signatureName` defaults to the
   * acting user's name; the sign-off is the compliance evidence of the review.
   */
  async completeTask(
    taskId: string,
    dto: CompleteReviewInput,
    user: AuthUser,
    ctx: RequestContext = {},
    now: Date = new Date(),
  ): Promise<ReviewTaskItem> {
    const task = await this.prisma.reviewTask.findUnique({
      where: { id: taskId },
      include: taskInclude,
    });
    if (!task) throw new NotFoundException('Review task not found');

    const canManage = user.permissions.includes(PERMISSIONS.REVIEW_MANAGE);
    if (task.assignedToId !== user.id && !canManage) {
      throw new ForbiddenException('You can only complete your own review tasks');
    }
    if (task.status === 'completed' || task.status === 'cancelled') {
      throw new BadRequestException('This review task is already closed');
    }

    let newNextReviewDate: Date;
    try {
      newNextReviewDate = advanceReviewDate({
        cadence: task.document.reviewCadence,
        now,
        override: dto.newNextReviewDate,
      });
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }

    // C6/D4: the task completion, the document's advanced review date, AND the
    // immutable `reviewed` sign-off commit ATOMICALLY — a completed review always
    // carries its evidence, and evidence never exists for an uncommitted completion.
    await this.prisma.$transaction(async (tx) => {
      await tx.reviewTask.update({
        where: { id: taskId },
        data: {
          status: 'completed',
          completedAt: now,
          completedById: user.id,
          notes: dto.notes,
        },
      });
      await tx.document.update({
        where: { id: task.documentId },
        data: { nextReviewDate: newNextReviewDate },
      });
      await this.attestation.record(
        {
          documentId: task.documentId,
          versionId: task.versionId ?? task.document.currentVersionId ?? null,
          action: 'reviewed',
          signatureName: dto.signatureName?.trim() || user.name,
          signatureRole: dto.signatureRole,
          comments: dto.notes,
          reviewTaskId: taskId,
        },
        user,
        ctx,
        tx,
      );
    });

    // Audit after commit (out of the critical path).
    await this.audit.record({
      action: AUDIT_ACTIONS.REVIEW_COMPLETED,
      actorUserId: user.id,
      documentId: task.documentId,
      versionId: task.versionId ?? undefined,
      targetType: 'review_task',
      ...ctx,
      metadata: { taskId, newNextReviewDate: newNextReviewDate.toISOString() },
    });

    return this.getTask(taskId, user);
  }

  // ---- Reads ---------------------------------------------------------------

  /**
   * Paginated review-task list. Non-managers are ALWAYS scoped to their own tasks
   * server-side (UI hiding is never the boundary — AGENTS.md §8); managers may
   * filter by any assignee or use `mine=true` for their own. Ordered soonest-due first.
   */
  async listTasks(query: ListReviewsQuery, user: AuthUser): Promise<Paginated<ReviewTaskItem>> {
    const canManage = user.permissions.includes(PERMISSIONS.REVIEW_MANAGE);
    const page = Math.max(Math.trunc(query.page ?? 1), 1);
    const pageSize = Math.min(
      Math.max(Math.trunc(query.pageSize ?? DEFAULT_PAGE_SIZE), 1),
      MAX_PAGE_SIZE,
    );

    const where: Prisma.ReviewTaskWhereInput = {};
    if (!canManage) {
      where.assignedToId = user.id;
    } else if (query.mine) {
      where.assignedToId = user.id;
    } else if (query.assignedToId) {
      where.assignedToId = query.assignedToId;
    }
    if (query.documentId) where.documentId = query.documentId;
    if (query.status) where.status = query.status;

    const from = parseDate(query.dueFrom);
    const to = parseDate(query.dueTo);
    if (from || to) {
      where.dueDate = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.reviewTask.findMany({
        where,
        include: taskInclude,
        orderBy: { dueDate: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.reviewTask.count({ where }),
    ]);

    const counts = await this.annotationCounts(rows);
    return { items: rows.map((r) => this.toTaskItem(r, counts.get(taskCountKey(r)) ?? 0)), total, page, pageSize };
  }

  /** Single task detail. Non-managers may only read their own task (else 403). */
  async getTask(id: string, user: AuthUser): Promise<ReviewTaskItem> {
    const task = await this.prisma.reviewTask.findUnique({ where: { id }, include: taskInclude });
    if (!task) throw new NotFoundException('Review task not found');
    const canManage = user.permissions.includes(PERMISSIONS.REVIEW_MANAGE);
    if (task.assignedToId !== user.id && !canManage) {
      throw new ForbiddenException('You can only view your own review tasks');
    }
    const counts = await this.annotationCounts([task]);
    return this.toTaskItem(task, counts.get(taskCountKey(task)) ?? 0);
  }

  /**
   * Clinic-wide review-compliance snapshot for the report cards. Counts in-force
   * documents (active, not archived/retired) split into overdue (past nextReviewDate),
   * due-soon (within the lead window), and current (everything else, incl. no date).
   */
  async complianceSummary(
    now: Date,
    leadTimeDays: number = DEFAULT_REVIEW_LEAD_DAYS,
  ): Promise<ComplianceSummary> {
    const dueThreshold = addDays(now, leadTimeDays);
    const base: Prisma.DocumentWhereInput = { deletedAt: null, status: INACTIVE_STATUSES };

    const [total, overdue, dueSoon] = await this.prisma.$transaction([
      this.prisma.document.count({ where: base }),
      this.prisma.document.count({
        where: { ...base, nextReviewDate: { not: null, lt: now } },
      }),
      this.prisma.document.count({
        where: { ...base, nextReviewDate: { gte: now, lte: dueThreshold } },
      }),
    ]);

    const current = Math.max(total - overdue - dueSoon, 0);
    const percentCurrent = total === 0 ? 100 : Math.round((current / total) * 100);
    return { totalDocuments: total, current, dueSoon, overdue, percentCurrent };
  }

  // ---- Helpers -------------------------------------------------------------

  private appUrl(): string {
    return (
      this.config.get<string>('WEB_APP_URL') ||
      this.config.get<string>('FRONTEND_URL') ||
      'http://localhost:5173'
    );
  }

  private async assertActiveDocument(documentId: string): Promise<void> {
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, deletedAt: null },
      select: { id: true },
    });
    if (!doc) throw new NotFoundException('Document not found');
  }

  private async annotationCounts(tasks: TaskWithJoins[]): Promise<Map<string, number>> {
    const targets = tasks
      .map((task) => ({ documentId: task.documentId, versionId: task.versionId ?? task.document.currentVersionId }))
      .filter((target): target is { documentId: string; versionId: string } => !!target.versionId);
    if (targets.length === 0) return new Map();
    const rows = await this.prisma.documentAnnotation.groupBy({
      by: ['documentId', 'versionId'],
      where: {
        deletedAt: null,
        status: 'open',
        OR: targets,
      },
      _count: { _all: true },
    });
    return new Map(rows.map((row) => [`${row.documentId}:${row.versionId}`, row._count._all]));
  }

  private toTaskItem(task: TaskWithJoins, unresolvedAnnotationCount = 0): ReviewTaskItem {
    return {
      id: task.id,
      documentId: task.documentId,
      documentTitle: task.document?.title ?? null,
      documentNumber: task.document?.documentNumber ?? null,
      versionId: task.versionId,
      dueDate: task.dueDate.toISOString(),
      status: task.status as ReviewTaskStatus,
      assignedToId: task.assignedToId,
      assignedToName: task.assignedTo?.name ?? null,
      completedAt: task.completedAt ? task.completedAt.toISOString() : null,
      completedByName: task.completedBy?.name ?? null,
      notes: task.notes,
      createdAt: task.createdAt.toISOString(),
      reviewCadence: task.document.reviewCadence,
      unresolvedAnnotationCount,
    };
  }
}

function taskCountKey(task: TaskWithJoins): string {
  return `${task.documentId}:${task.versionId ?? task.document.currentVersionId ?? ''}`;
}

/** Parses an ISO date, returning undefined for missing/invalid input. */
function parseDate(value?: string): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
