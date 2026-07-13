import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AUDIT_ACTIONS,
  type AckStatus,
  type AcknowledgmentStatusRow,
  type AcknowledgmentStatusSummary,
  type AcknowledgeInput,
  type AttestationItem,
  type AuthUser,
  type DistributeAcknowledgmentInput,
  type MyAcknowledgmentItem,
} from '@policymanager/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { RequestContext } from '../audit/request-context';
import { AttestationService } from './attestation.service';

/** Assignment fields + joins for the manager status view. */
const statusInclude = {
  assignee: { select: { id: true, name: true, email: true } },
  version: { select: { versionNumber: true } },
} satisfies Prisma.AcknowledgmentAssignmentInclude;

type StatusRow = Prisma.AcknowledgmentAssignmentGetPayload<{ include: typeof statusInclude }>;

/**
 * Staff read-and-acknowledge distribution (AGENTS.md §10b; skill
 * acknowledgment-distribution).
 *
 * Responsibilities:
 *  - distribute a document's CURRENT version to users and/or role members
 *    (idempotent per version+assignee),
 *  - list a staff member's own assignments,
 *  - per-assignee completion status for the manager view,
 *  - the acknowledge action — gated on the assignee having VIEWED the document —
 *    which records an immutable `Attestation(action=acknowledged)` and completes
 *    the assignment,
 *  - re-trigger on a new published version (fresh pending rows for prior assignees;
 *    prior completions stay as historical evidence but do not satisfy the new
 *    version),
 *  - sweep past-due pending assignments to `overdue`.
 */
@Injectable()
export class AcknowledgmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly attestation: AttestationService,
  ) {}

  /**
   * Distributes a document's current version for acknowledgment to the union of
   * `assigneeIds` and the members of `roleNames`, de-duplicated. Idempotent: an
   * assignee already assigned for this version is left untouched (completed
   * evidence is preserved). Audits `acknowledgment.assigned`.
   */
  async distribute(
    documentId: string,
    input: DistributeAcknowledgmentInput,
    actor: AuthUser,
    ctx: RequestContext = {},
  ): Promise<AcknowledgmentStatusSummary> {
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, deletedAt: null },
      select: { id: true, currentVersionId: true },
    });
    if (!doc) throw new NotFoundException('Document not found');
    if (!doc.currentVersionId) {
      throw new BadRequestException('Upload and publish a version before distributing for acknowledgment');
    }

    const assigneeIds = await this.resolveAssignees(input);
    if (assigneeIds.length === 0) {
      throw new BadRequestException('Select at least one user or role to distribute to');
    }

    const dueDate = parseDate(input.dueDate);
    let created = 0;
    for (const assigneeId of assigneeIds) {
      const existing = await this.prisma.acknowledgmentAssignment.findUnique({
        where: { versionId_assigneeId: { versionId: doc.currentVersionId, assigneeId } },
        select: { id: true },
      });
      if (existing) continue; // Idempotent — keep the existing (possibly completed) row.
      await this.prisma.acknowledgmentAssignment.create({
        data: {
          documentId,
          versionId: doc.currentVersionId,
          assigneeId,
          assignedById: actor.id,
          dueDate: dueDate ?? undefined,
          status: 'pending',
        },
      });
      created += 1;
    }

    await this.audit.record({
      action: AUDIT_ACTIONS.ACKNOWLEDGMENT_ASSIGNED,
      actorUserId: actor.id,
      documentId,
      versionId: doc.currentVersionId,
      targetType: 'acknowledgment',
      ...ctx,
      metadata: { versionId: doc.currentVersionId, assigned: created, targeted: assigneeIds.length },
    });

    return this.statusForDocument(documentId);
  }

  /**
   * Re-triggers acknowledgment for a newly published version: creates a fresh
   * `pending` assignment for every DISTINCT assignee the document has EVER been
   * distributed to, against `versionId`. Idempotent via the (versionId,assigneeId)
   * unique constraint — re-publishing the SAME version creates nothing (they
   * already have a row for it); a NEW version yields fresh pending rows. Prior
   * completed rows remain as historical evidence but do not satisfy the new version.
   */
  async retriggerForVersion(
    documentId: string,
    versionId: string,
    actor: AuthUser,
    ctx: RequestContext = {},
  ): Promise<number> {
    const priorAssignees = await this.prisma.acknowledgmentAssignment.findMany({
      where: { documentId, versionId: { not: versionId } },
      select: { assigneeId: true },
      distinct: ['assigneeId'],
    });
    if (priorAssignees.length === 0) return 0;

    let created = 0;
    for (const { assigneeId } of priorAssignees) {
      const existing = await this.prisma.acknowledgmentAssignment.findUnique({
        where: { versionId_assigneeId: { versionId, assigneeId } },
        select: { id: true },
      });
      if (existing) continue;
      await this.prisma.acknowledgmentAssignment.create({
        data: { documentId, versionId, assigneeId, assignedById: actor.id, status: 'pending' },
      });
      created += 1;
    }

    if (created > 0) {
      await this.audit.record({
        action: AUDIT_ACTIONS.ACKNOWLEDGMENT_ASSIGNED,
        actorUserId: actor.id,
        documentId,
        versionId,
        targetType: 'acknowledgment',
        ...ctx,
        metadata: { versionId, assigned: created, reason: 'republish' },
      });
    }
    return created;
  }

  /**
   * A staff member's own acknowledgment assignments — open (pending/overdue) first
   * by due date, then most-recently completed. Drives the "My Acknowledgments" page.
   */
  async listMine(user: AuthUser): Promise<MyAcknowledgmentItem[]> {
    const rows = await this.prisma.acknowledgmentAssignment.findMany({
      where: { assigneeId: user.id },
      include: {
        document: { select: { title: true, documentNumber: true } },
        version: { select: { versionNumber: true } },
        assignedBy: { select: { name: true } },
      },
    });
    const items = rows.map((r) => ({
      id: r.id,
      documentId: r.documentId,
      documentTitle: r.document?.title ?? null,
      documentNumber: r.document?.documentNumber ?? null,
      versionId: r.versionId,
      versionNumber: r.version?.versionNumber ?? null,
      status: r.status as AckStatus,
      dueDate: r.dueDate ? r.dueDate.toISOString() : null,
      completedAt: r.completedAt ? r.completedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
      assignedByName: r.assignedBy?.name ?? null,
    }));
    const isOpen = (s: AckStatus) => s === 'pending' || s === 'overdue';
    return items.sort((a, b) => {
      if (isOpen(a.status) !== isOpen(b.status)) return isOpen(a.status) ? -1 : 1;
      if (isOpen(a.status)) return (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999');
      return (b.completedAt ?? '').localeCompare(a.completedAt ?? '');
    });
  }

  /**
   * Per-assignee acknowledgment status + completion percentage for the manager
   * view. Reports on the LATEST distributed version (by version number) so it
   * reflects the active distribution even if the document pointer has since moved.
   */
  async statusForDocument(documentId: string): Promise<AcknowledgmentStatusSummary> {
    const all = await this.prisma.acknowledgmentAssignment.findMany({
      where: { documentId },
      include: statusInclude,
    });
    if (all.length === 0) {
      return {
        documentId,
        versionId: null,
        versionNumber: null,
        total: 0,
        completed: 0,
        pending: 0,
        overdue: 0,
        percentComplete: 100,
        rows: [],
      };
    }

    // Pick the latest distributed version (highest version number).
    const latest = all.reduce((best, r) =>
      (r.version?.versionNumber ?? 0) > (best.version?.versionNumber ?? 0) ? r : best,
    );
    const versionId = latest.versionId;
    const scoped = all.filter((r) => r.versionId === versionId);

    const rows: AcknowledgmentStatusRow[] = scoped
      .map((r) => this.toStatusRow(r))
      .sort((a, b) => (a.assigneeName ?? '').localeCompare(b.assigneeName ?? ''));

    const completed = scoped.filter((r) => r.status === 'completed').length;
    const overdue = scoped.filter((r) => r.status === 'overdue').length;
    const pending = scoped.filter((r) => r.status === 'pending').length;
    const total = scoped.length;

    return {
      documentId,
      versionId,
      versionNumber: latest.version?.versionNumber ?? null,
      total,
      completed,
      pending,
      overdue,
      percentComplete: total === 0 ? 100 : Math.round((completed / total) * 100),
      rows,
    };
  }

  /**
   * Records a staff acknowledgment: verifies ownership + that the document was
   * viewed, writes an immutable `Attestation(action=acknowledged)`, and marks the
   * assignment completed. `hasViewed` MUST be true — the assignee has to open and
   * read the document first (AGENTS.md §10b). Idempotent-safe: a completed/cancelled
   * assignment is rejected.
   */
  async acknowledge(
    assignmentId: string,
    input: AcknowledgeInput,
    user: AuthUser,
    ctx: RequestContext = {},
  ): Promise<{ assignment: MyAcknowledgmentItem; attestation: AttestationItem }> {
    const assignment = await this.prisma.acknowledgmentAssignment.findUnique({
      where: { id: assignmentId },
      include: {
        document: { select: { title: true, documentNumber: true } },
        version: { select: { versionNumber: true } },
        assignedBy: { select: { name: true } },
      },
    });
    if (!assignment) throw new NotFoundException('Acknowledgment assignment not found');
    if (assignment.assigneeId !== user.id) {
      throw new ForbiddenException('You can only acknowledge your own assignments');
    }
    if (assignment.status === 'completed') {
      throw new BadRequestException('You have already acknowledged this document version');
    }
    if (assignment.status === 'cancelled') {
      throw new BadRequestException('This acknowledgment assignment has been cancelled');
    }
    if (input.hasViewed !== true) {
      throw new BadRequestException('You must open and read the document before acknowledging');
    }

    const attestation = await this.attestation.record(
      {
        documentId: assignment.documentId,
        versionId: assignment.versionId,
        action: 'acknowledged',
        signatureName: input.signatureName?.trim() || user.name,
        signatureRole: input.signatureRole,
        comments: input.comments,
        acknowledgmentAssignmentId: assignment.id,
      },
      user,
      ctx,
    );

    const updated = await this.prisma.acknowledgmentAssignment.update({
      where: { id: assignment.id },
      data: { status: 'completed', completedAt: new Date() },
      include: {
        document: { select: { title: true, documentNumber: true } },
        version: { select: { versionNumber: true } },
        assignedBy: { select: { name: true } },
      },
    });

    return {
      assignment: {
        id: updated.id,
        documentId: updated.documentId,
        documentTitle: updated.document?.title ?? null,
        documentNumber: updated.document?.documentNumber ?? null,
        versionId: updated.versionId,
        versionNumber: updated.version?.versionNumber ?? null,
        status: updated.status as AckStatus,
        dueDate: updated.dueDate ? updated.dueDate.toISOString() : null,
        completedAt: updated.completedAt ? updated.completedAt.toISOString() : null,
        createdAt: updated.createdAt.toISOString(),
        assignedByName: updated.assignedBy?.name ?? null,
      },
      attestation,
    };
  }

  /** Flips past-due `pending` assignments to `overdue`. Returns the count updated. */
  async markOverdue(now: Date): Promise<number> {
    const res = await this.prisma.acknowledgmentAssignment.updateMany({
      where: { status: 'pending', dueDate: { not: null, lt: now } },
      data: { status: 'overdue' },
    });
    return res.count;
  }

  // ---- Helpers -------------------------------------------------------------

  /** Resolves explicit user ids + role members into a de-duplicated assignee set. */
  private async resolveAssignees(input: DistributeAcknowledgmentInput): Promise<string[]> {
    const ids = new Set<string>();

    if (input.assigneeIds && input.assigneeIds.length > 0) {
      const users = await this.prisma.user.findMany({
        where: { id: { in: input.assigneeIds } },
        select: { id: true },
      });
      const found = new Set(users.map((u) => u.id));
      const missing = input.assigneeIds.filter((id) => !found.has(id));
      if (missing.length > 0) {
        throw new BadRequestException(`Unknown user id(s): ${missing.join(', ')}`);
      }
      users.forEach((u) => ids.add(u.id));
    }

    if (input.roleNames && input.roleNames.length > 0) {
      const roles = await this.prisma.role.findMany({
        where: { name: { in: input.roleNames } },
        select: { id: true, name: true },
      });
      const foundNames = new Set(roles.map((r) => r.name));
      const missing = input.roleNames.filter((n) => !foundNames.has(n));
      if (missing.length > 0) {
        throw new BadRequestException(`Unknown role(s): ${missing.join(', ')}`);
      }
      const members = await this.prisma.userRole.findMany({
        where: { roleId: { in: roles.map((r) => r.id) } },
        select: { userId: true },
      });
      members.forEach((m) => ids.add(m.userId));
    }

    return [...ids];
  }

  private toStatusRow(r: StatusRow): AcknowledgmentStatusRow {
    return {
      assignmentId: r.id,
      assigneeId: r.assigneeId,
      assigneeName: r.assignee?.name ?? null,
      assigneeEmail: r.assignee?.email ?? null,
      status: r.status as AckStatus,
      dueDate: r.dueDate ? r.dueDate.toISOString() : null,
      completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    };
  }
}

/** Parses an ISO date, returning null for missing/invalid input. */
function parseDate(value?: string): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
