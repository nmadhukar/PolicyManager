import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '@policymanager/shared';
import { AcknowledgmentService } from './acknowledgment.service';

/**
 * Business-behavior tests for staff acknowledgment distribution (AGENTS.md §10b).
 * Prisma, audit, and the attestation store are mocked to assert: idempotent
 * distribution, role expansion, the view-before-acknowledge gate, the immutable
 * acknowledged sign-off, re-trigger on a new version, and the overdue sweep.
 */
describe('AcknowledgmentService', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const makePrisma = (): any => ({
    document: { findFirst: jest.fn() },
    user: { findMany: jest.fn().mockResolvedValue([]) },
    role: { findMany: jest.fn().mockResolvedValue([]) },
    userRole: { findMany: jest.fn().mockResolvedValue([]) },
    acknowledgmentAssignment: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'asg-new' }),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  });
  const makeAudit = () => ({ record: jest.fn().mockResolvedValue('ae-1') });
  const makeAttestation = () => ({ record: jest.fn().mockResolvedValue({ id: 'att-1', action: 'acknowledged' }) });

  const build = (prisma = makePrisma(), audit = makeAudit(), attestation = makeAttestation()) => ({
    prisma,
    audit,
    attestation,
    svc: new AcknowledgmentService(prisma as never, audit as never, attestation as never),
  });

  const manager: AuthUser = {
    id: 'mgr-1',
    email: 'm@x.com',
    name: 'Morgan Manager',
    roles: ['Manager'],
    permissions: ['review.manage'],
    mustChangePassword: false,
  };
  const staff: AuthUser = {
    id: 'staff-1',
    email: 's@x.com',
    name: 'Sam Staff',
    roles: ['Staff'],
    permissions: ['document.read'],
    mustChangePassword: false,
  };

  describe('distribute', () => {
    it('assigns the union of explicit users + role members (deduped), idempotently', async () => {
      const { svc, prisma, audit } = build();
      prisma.document.findFirst.mockResolvedValue({ id: 'doc-1', currentVersionId: 'v-2' });
      prisma.user.findMany.mockResolvedValue([{ id: 'staff-1' }]);
      prisma.role.findMany.mockResolvedValue([{ id: 'role-staff', name: 'Staff' }]);
      // Role members include staff-1 (dup) + staff-2.
      prisma.userRole.findMany.mockResolvedValue([{ userId: 'staff-1' }, { userId: 'staff-2' }]);
      prisma.acknowledgmentAssignment.findMany.mockResolvedValue([]);

      await svc.distribute(
        'doc-1',
        { assigneeIds: ['staff-1'], roleNames: ['Staff'], dueDate: '2026-08-01' },
        manager,
      );

      // Two distinct assignees (staff-1, staff-2) => two creates against v-2.
      expect(prisma.acknowledgmentAssignment.create).toHaveBeenCalledTimes(2);
      const created = prisma.acknowledgmentAssignment.create.mock.calls.map((c: unknown[]) => (c[0] as { data: { assigneeId: string; versionId: string } }).data);
      expect(new Set(created.map((d: { assigneeId: string }) => d.assigneeId))).toEqual(new Set(['staff-1', 'staff-2']));
      expect(created.every((d: { versionId: string }) => d.versionId === 'v-2')).toBe(true);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'acknowledgment.assigned' }),
      );
    });

    it('skips an assignee already assigned for the version (idempotent, preserves evidence)', async () => {
      const { svc, prisma } = build();
      prisma.document.findFirst.mockResolvedValue({ id: 'doc-1', currentVersionId: 'v-2' });
      prisma.user.findMany.mockResolvedValue([{ id: 'staff-1' }]);
      prisma.acknowledgmentAssignment.findUnique.mockResolvedValue({ id: 'existing' });

      await svc.distribute('doc-1', { assigneeIds: ['staff-1'] }, manager);
      expect(prisma.acknowledgmentAssignment.create).not.toHaveBeenCalled();
    });

    it('400s when the document has no current version to distribute', async () => {
      const { svc, prisma } = build();
      prisma.document.findFirst.mockResolvedValue({ id: 'doc-1', currentVersionId: null });
      await expect(svc.distribute('doc-1', { assigneeIds: ['staff-1'] }, manager)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('400s when no assignees resolve', async () => {
      const { svc, prisma } = build();
      prisma.document.findFirst.mockResolvedValue({ id: 'doc-1', currentVersionId: 'v-2' });
      await expect(svc.distribute('doc-1', {}, manager)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('400s on an unknown user id', async () => {
      const { svc, prisma } = build();
      prisma.document.findFirst.mockResolvedValue({ id: 'doc-1', currentVersionId: 'v-2' });
      prisma.user.findMany.mockResolvedValue([]); // none found
      await expect(
        svc.distribute('doc-1', { assigneeIds: ['ghost'] }, manager),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('404s a missing/deleted document', async () => {
      const { svc, prisma } = build();
      prisma.document.findFirst.mockResolvedValue(null);
      await expect(svc.distribute('gone', { assigneeIds: ['staff-1'] }, manager)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('retriggerForVersion', () => {
    it('creates fresh pending rows for prior distinct assignees against the new version', async () => {
      const { svc, prisma } = build();
      prisma.acknowledgmentAssignment.findMany.mockResolvedValue([
        { assigneeId: 'staff-1' },
        { assigneeId: 'staff-2' },
      ]);
      prisma.acknowledgmentAssignment.findUnique.mockResolvedValue(null); // none exist for v-3 yet

      const count = await svc.retriggerForVersion('doc-1', 'v-3', manager);
      expect(count).toBe(2);
      const created = prisma.acknowledgmentAssignment.create.mock.calls.map((c: unknown[]) => (c[0] as { data: { versionId: string; status: string } }).data);
      expect(created.every((d: { versionId: string; status: string }) => d.versionId === 'v-3' && d.status === 'pending')).toBe(true);
      // The lookup for prior assignees excludes the target version.
      expect(prisma.acknowledgmentAssignment.findMany.mock.calls[0][0].where).toEqual({
        documentId: 'doc-1',
        versionId: { not: 'v-3' },
      });
    });

    it('creates nothing (idempotent) when re-publishing the SAME version', async () => {
      const { svc, prisma } = build();
      // The prior-assignee query excludes the target version, so re-publishing the
      // same version finds no *other*-version assignees to carry forward.
      prisma.acknowledgmentAssignment.findMany.mockResolvedValue([]);
      const count = await svc.retriggerForVersion('doc-1', 'v-2', manager);
      expect(count).toBe(0);
      expect(prisma.acknowledgmentAssignment.create).not.toHaveBeenCalled();
    });

    it('skips assignees who already have a row for the new version', async () => {
      const { svc, prisma } = build();
      prisma.acknowledgmentAssignment.findMany.mockResolvedValue([{ assigneeId: 'staff-1' }]);
      prisma.acknowledgmentAssignment.findUnique.mockResolvedValue({ id: 'already' });
      const count = await svc.retriggerForVersion('doc-1', 'v-3', manager);
      expect(count).toBe(0);
    });
  });

  describe('acknowledge', () => {
    const assignmentRow = (over: Record<string, unknown> = {}) => ({
      id: 'asg-1',
      documentId: 'doc-1',
      versionId: 'v-2',
      assigneeId: 'staff-1',
      assignedById: 'mgr-1',
      dueDate: null,
      status: 'pending',
      completedAt: null,
      createdAt: new Date('2026-07-01T00:00:00Z'),
      document: { title: 'Policy', documentNumber: 'PP-1' },
      version: { versionNumber: 2 },
      assignedBy: { name: 'Morgan Manager' },
      ...over,
    });

    it('records an acknowledged sign-off and completes the assignment', async () => {
      const { svc, prisma, attestation } = build();
      prisma.acknowledgmentAssignment.findUnique.mockResolvedValue(assignmentRow());
      prisma.acknowledgmentAssignment.update.mockResolvedValue(
        assignmentRow({ status: 'completed', completedAt: new Date('2026-07-13T00:00:00Z') }),
      );

      const res = await svc.acknowledge('asg-1', { hasViewed: true, signatureRole: 'Nurse' }, staff, {
        ipAddress: '10.0.0.9',
      });

      expect(attestation.record).toHaveBeenCalledWith(
        expect.objectContaining({
          documentId: 'doc-1',
          versionId: 'v-2',
          action: 'acknowledged',
          signatureName: 'Sam Staff', // defaulted to the acting user
          signatureRole: 'Nurse',
          acknowledgmentAssignmentId: 'asg-1',
        }),
        staff,
        { ipAddress: '10.0.0.9' },
      );
      expect(prisma.acknowledgmentAssignment.update.mock.calls[0][0].data).toMatchObject({
        status: 'completed',
      });
      expect(res.assignment.status).toBe('completed');
      expect(res.attestation.action).toBe('acknowledged');
    });

    it('rejects acknowledging without having viewed the document (AGENTS.md §10b)', async () => {
      const { svc, prisma, attestation } = build();
      prisma.acknowledgmentAssignment.findUnique.mockResolvedValue(assignmentRow());
      await expect(svc.acknowledge('asg-1', { hasViewed: false }, staff)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(attestation.record).not.toHaveBeenCalled();
    });

    it('forbids acknowledging someone else\'s assignment', async () => {
      const { svc, prisma } = build();
      prisma.acknowledgmentAssignment.findUnique.mockResolvedValue(
        assignmentRow({ assigneeId: 'other' }),
      );
      await expect(svc.acknowledge('asg-1', { hasViewed: true }, staff)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('rejects re-acknowledging an already-completed assignment', async () => {
      const { svc, prisma } = build();
      prisma.acknowledgmentAssignment.findUnique.mockResolvedValue(
        assignmentRow({ status: 'completed' }),
      );
      await expect(svc.acknowledge('asg-1', { hasViewed: true }, staff)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('404s a missing assignment', async () => {
      const { svc, prisma } = build();
      prisma.acknowledgmentAssignment.findUnique.mockResolvedValue(null);
      await expect(svc.acknowledge('gone', { hasViewed: true }, staff)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('markOverdue', () => {
    it('flips past-due pending assignments to overdue', async () => {
      const { svc, prisma } = build();
      prisma.acknowledgmentAssignment.updateMany.mockResolvedValue({ count: 4 });
      const now = new Date('2026-07-13T00:00:00Z');
      const count = await svc.markOverdue(now);
      expect(count).toBe(4);
      const where = prisma.acknowledgmentAssignment.updateMany.mock.calls[0][0].where;
      expect(where.status).toBe('pending');
      expect(where.dueDate).toEqual({ not: null, lt: now });
    });
  });

  describe('statusForDocument', () => {
    it('reports completion % for the latest distributed version', async () => {
      const { svc, prisma } = build();
      prisma.acknowledgmentAssignment.findMany.mockResolvedValue([
        // Older version v1 (ignored in the summary scope).
        { id: 'o1', versionId: 'v-1', assigneeId: 's1', status: 'completed', dueDate: null, completedAt: new Date(), assignee: { id: 's1', name: 'A', email: 'a@x' }, version: { versionNumber: 1 } },
        // Latest version v2: 1 completed of 2 => 50%.
        { id: 'n1', versionId: 'v-2', assigneeId: 's1', status: 'completed', dueDate: null, completedAt: new Date(), assignee: { id: 's1', name: 'A', email: 'a@x' }, version: { versionNumber: 2 } },
        { id: 'n2', versionId: 'v-2', assigneeId: 's2', status: 'pending', dueDate: null, completedAt: null, assignee: { id: 's2', name: 'B', email: 'b@x' }, version: { versionNumber: 2 } },
      ]);

      const summary = await svc.statusForDocument('doc-1');
      expect(summary.versionId).toBe('v-2');
      expect(summary.total).toBe(2);
      expect(summary.completed).toBe(1);
      expect(summary.pending).toBe(1);
      expect(summary.percentComplete).toBe(50);
      expect(summary.rows).toHaveLength(2);
    });

    it('returns an empty 100% summary when never distributed', async () => {
      const { svc, prisma } = build();
      prisma.acknowledgmentAssignment.findMany.mockResolvedValue([]);
      const summary = await svc.statusForDocument('doc-1');
      expect(summary).toMatchObject({ versionId: null, total: 0, percentComplete: 100, rows: [] });
    });
  });

  describe('listMine', () => {
    it('orders open (pending/overdue) before completed', async () => {
      const { svc, prisma } = build();
      prisma.acknowledgmentAssignment.findMany.mockResolvedValue([
        { id: 'c', documentId: 'd', versionId: 'v', assigneeId: 'staff-1', status: 'completed', dueDate: null, completedAt: new Date('2026-07-10'), createdAt: new Date('2026-06-01'), document: { title: 'C', documentNumber: null }, version: { versionNumber: 1 }, assignedBy: { name: 'M' } },
        { id: 'p', documentId: 'd', versionId: 'v', assigneeId: 'staff-1', status: 'pending', dueDate: new Date('2026-08-01'), completedAt: null, createdAt: new Date('2026-06-02'), document: { title: 'P', documentNumber: null }, version: { versionNumber: 1 }, assignedBy: { name: 'M' } },
      ]);
      const items = await svc.listMine(staff);
      expect(items[0].status).toBe('pending');
      expect(items[1].status).toBe('completed');
    });
  });
});
