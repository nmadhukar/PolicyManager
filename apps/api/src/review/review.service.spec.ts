import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthUser } from '@policymanager/shared';
import { ReviewService } from './review.service';

/**
 * Business-behavior tests for the QC review service. All clock use is injected so
 * the sweep/completion/compliance logic is deterministic (AGENTS.md §6). Prisma,
 * mail, and audit are mocked to assert orchestration + idempotency contracts.
 */
describe('ReviewService', () => {
  const config = new ConfigService({ FRONTEND_URL: 'http://localhost:5173' });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const makePrisma = (): any => ({
    document: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]), count: jest.fn(), update: jest.fn() },
    user: { findUnique: jest.fn() },
    reviewAssignment: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      delete: jest.fn(),
    },
    reviewTask: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: 'task-new' }),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  });
  const makeMail = () => ({ sendReviewReminder: jest.fn().mockResolvedValue(true) });
  const makeAudit = () => ({ record: jest.fn().mockResolvedValue('ae-1') });
  const makeAttestation = () => ({ record: jest.fn().mockResolvedValue({ id: 'att-1' }) });
  const makeAcknowledgment = () => ({ markOverdue: jest.fn().mockResolvedValue(0) });

  const build = (
    prisma = makePrisma(),
    mail = makeMail(),
    audit = makeAudit(),
    attestation = makeAttestation(),
    acknowledgment = makeAcknowledgment(),
  ) => ({
    prisma,
    mail,
    audit,
    attestation,
    acknowledgment,
    svc: new ReviewService(
      prisma as never,
      config,
      mail as never,
      audit as never,
      attestation as never,
      acknowledgment as never,
    ),
  });

  const manager: AuthUser = {
    id: 'mgr-1',
    email: 'm@x.com',
    name: 'Manager',
    roles: ['Manager'],
    permissions: ['review.manage'],
    mustChangePassword: false,
  };
  const staff: AuthUser = {
    id: 'staff-1',
    email: 's@x.com',
    name: 'Staff',
    roles: ['Staff'],
    permissions: ['document.read'],
    mustChangePassword: false,
  };

  const NOW = new Date('2026-07-13T00:00:00.000Z');

  describe('runReviewSweep', () => {
    const reviewerA = { id: 'rev-a', name: 'Rev A', email: 'a@x.com' };
    const reviewerB = { id: 'rev-b', name: 'Rev B', email: 'b@x.com' };
    const owner = { id: 'own-1', name: 'Owner', email: 'owner@x.com' };

    it('queries with a lead-time window and the open-task idempotency guard', async () => {
      const { svc, prisma } = build();
      prisma.document.findMany.mockResolvedValue([]);
      await svc.runReviewSweep(NOW, 14);

      const where = prisma.document.findMany.mock.calls[0][0].where;
      // Active only.
      expect(where.deletedAt).toBeNull();
      expect(where.status).toEqual({ notIn: ['archived', 'retired'] });
      // nextReviewDate <= now + 14d.
      expect(where.nextReviewDate.lte.toISOString()).toBe('2026-07-27T00:00:00.000Z');
      // Skips documents that already have an OPEN task (idempotent).
      expect(where.reviewTasks).toEqual({
        none: { status: { in: ['pending', 'in_progress', 'overdue'] } },
      });
    });

    it('creates one task per assigned reviewer and emails each', async () => {
      const { svc, prisma, mail, audit } = build();
      prisma.document.findMany.mockResolvedValue([
        {
          id: 'doc-1',
          title: 'Intake Policy',
          nextReviewDate: new Date('2026-07-20T00:00:00Z'),
          currentVersionId: 'v1',
          owner,
          reviewAssignments: [{ reviewer: reviewerA }, { reviewer: reviewerB }],
        },
      ]);

      const res = await svc.runReviewSweep(NOW);

      expect(res.tasksCreated).toBe(2);
      expect(prisma.reviewTask.create).toHaveBeenCalledTimes(2);
      // Each created task references the current version + due date.
      const firstData = prisma.reviewTask.create.mock.calls[0][0].data;
      expect(firstData).toMatchObject({ documentId: 'doc-1', versionId: 'v1', assignedToId: 'rev-a', status: 'pending' });
      // Emails to both reviewers (not overdue — due is in the future).
      expect(mail.sendReviewReminder).toHaveBeenCalledTimes(2);
      expect(mail.sendReviewReminder.mock.calls[0][0]).toMatchObject({
        to: 'a@x.com',
        overdue: false,
        reviewUrl: 'http://localhost:5173/library/doc-1',
      });
      // Each task creation is audited (system source).
      expect(
        audit.record.mock.calls.filter((c: unknown[]) => (c[0] as { action: string }).action === 'review.task_created'),
      ).toHaveLength(2);
    });

    it('falls back to the document owner when there are no assigned reviewers', async () => {
      const { svc, prisma, mail } = build();
      prisma.document.findMany.mockResolvedValue([
        {
          id: 'doc-2',
          title: 'Safety Plan',
          nextReviewDate: new Date('2026-07-15T00:00:00Z'),
          currentVersionId: null,
          owner,
          reviewAssignments: [],
        },
      ]);

      const res = await svc.runReviewSweep(NOW);
      expect(res.tasksCreated).toBe(1);
      expect(prisma.reviewTask.create.mock.calls[0][0].data.assignedToId).toBe('own-1');
      expect(mail.sendReviewReminder.mock.calls[0][0].to).toBe('owner@x.com');
    });

    it('flags a past-due reminder as overdue and marks past-due open tasks overdue', async () => {
      const { svc, prisma, mail } = build();
      prisma.document.findMany.mockResolvedValue([
        {
          id: 'doc-3',
          title: 'Old Policy',
          nextReviewDate: new Date('2026-06-01T00:00:00Z'), // in the past vs NOW
          currentVersionId: 'v9',
          owner,
          reviewAssignments: [{ reviewer: reviewerA }],
        },
      ]);
      prisma.reviewTask.updateMany.mockResolvedValue({ count: 3 });

      const res = await svc.runReviewSweep(NOW);
      expect(mail.sendReviewReminder.mock.calls[0][0].overdue).toBe(true);
      // Past-due open tasks flipped to overdue.
      const upd = prisma.reviewTask.updateMany.mock.calls[0][0];
      expect(upd.where.status).toEqual({ in: ['pending', 'in_progress'] });
      expect(upd.where.dueDate.lt).toBe(NOW);
      expect(upd.data).toEqual({ status: 'overdue' });
      expect(res.overdueMarked).toBe(3);
    });

    it('does nothing when no documents are due (empty, idempotent)', async () => {
      const { svc, prisma, mail } = build();
      prisma.document.findMany.mockResolvedValue([]);
      const res = await svc.runReviewSweep(NOW);
      expect(res).toEqual({ tasksCreated: 0, overdueMarked: 0, documentsConsidered: 0 });
      expect(prisma.reviewTask.create).not.toHaveBeenCalled();
      expect(mail.sendReviewReminder).not.toHaveBeenCalled();
    });
  });

  describe('completeTask', () => {
    const taskRow = (over: Record<string, unknown> = {}) => ({
      id: 'task-1',
      documentId: 'doc-1',
      versionId: 'v1',
      dueDate: new Date('2026-07-01T00:00:00Z'),
      assignedToId: 'staff-1',
      status: 'pending',
      completedAt: null,
      completedById: null,
      notes: null,
      createdAt: new Date('2026-06-20T00:00:00Z'),
      document: { title: 'Doc', documentNumber: 'D-1', reviewCadence: 'quarterly', currentVersionId: 'v1' },
      assignedTo: { name: 'Staff' },
      completedBy: null,
      ...over,
    });

    it('lets the assignee complete and advances nextReviewDate by cadence (+3mo)', async () => {
      const { svc, prisma, audit } = build();
      prisma.reviewTask.findUnique
        .mockResolvedValueOnce(taskRow()) // completeTask load
        .mockResolvedValueOnce(taskRow({ status: 'completed', completedBy: { name: 'Staff' } })); // getTask reload
      prisma.reviewTask.update.mockResolvedValue({});
      prisma.document.update.mockResolvedValue({});

      const item = await svc.completeTask('task-1', { notes: 'looks good' }, staff, {}, NOW);

      // Task completed with the injected clock + notes.
      expect(prisma.reviewTask.update.mock.calls[0][0].data).toMatchObject({
        status: 'completed',
        completedById: 'staff-1',
        notes: 'looks good',
      });
      // Document nextReviewDate advanced 3 months from NOW.
      expect(prisma.document.update.mock.calls[0][0].data.nextReviewDate.toISOString()).toBe(
        '2026-10-13T00:00:00.000Z',
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'review.completed', actorUserId: 'staff-1' }),
      );
      expect(item.status).toBe('completed');
    });

    it('records an immutable reviewed attestation tied to the task + version', async () => {
      const { svc, prisma, attestation } = build();
      prisma.reviewTask.findUnique
        .mockResolvedValueOnce(taskRow())
        .mockResolvedValueOnce(taskRow({ status: 'completed' }));
      prisma.reviewTask.update.mockResolvedValue({});
      prisma.document.update.mockResolvedValue({});

      await svc.completeTask('task-1', { notes: 'ok', signatureRole: 'RN' }, staff, {}, NOW);

      expect(attestation.record).toHaveBeenCalledWith(
        expect.objectContaining({
          documentId: 'doc-1',
          versionId: 'v1',
          action: 'reviewed',
          reviewTaskId: 'task-1',
          signatureName: 'Staff', // defaulted to the acting user's name
          signatureRole: 'RN',
          comments: 'ok',
        }),
        staff,
        {},
      );
    });

    it('honours an explicit signatureName on the sign-off', async () => {
      const { svc, prisma, attestation } = build();
      prisma.reviewTask.findUnique
        .mockResolvedValueOnce(taskRow())
        .mockResolvedValueOnce(taskRow({ status: 'completed' }));
      prisma.reviewTask.update.mockResolvedValue({});
      prisma.document.update.mockResolvedValue({});

      await svc.completeTask('task-1', { signatureName: 'Dr. Staff' }, staff, {}, NOW);
      expect(attestation.record.mock.calls[0][0].signatureName).toBe('Dr. Staff');
    });

    it('lets a review.manage user complete someone else\'s task', async () => {
      const { svc, prisma } = build();
      prisma.reviewTask.findUnique
        .mockResolvedValueOnce(taskRow({ assignedToId: 'other-user' }))
        .mockResolvedValueOnce(taskRow({ assignedToId: 'other-user', status: 'completed' }));
      prisma.reviewTask.update.mockResolvedValue({});
      prisma.document.update.mockResolvedValue({});
      await expect(
        svc.completeTask('task-1', {}, manager, {}, NOW),
      ).resolves.toBeDefined();
    });

    it('forbids a non-manager from completing a task that is not theirs', async () => {
      const { svc, prisma } = build();
      prisma.reviewTask.findUnique.mockResolvedValue(taskRow({ assignedToId: 'someone-else' }));
      await expect(svc.completeTask('task-1', {}, staff, {}, NOW)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.reviewTask.update).not.toHaveBeenCalled();
    });

    it('404s a missing task', async () => {
      const { svc, prisma } = build();
      prisma.reviewTask.findUnique.mockResolvedValue(null);
      await expect(svc.completeTask('gone', {}, manager, {}, NOW)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('rejects completing an already-closed task', async () => {
      const { svc, prisma } = build();
      prisma.reviewTask.findUnique.mockResolvedValue(taskRow({ status: 'completed' }));
      await expect(svc.completeTask('task-1', {}, manager, {}, NOW)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('requires newNextReviewDate for a custom-cadence document', async () => {
      const { svc, prisma } = build();
      prisma.reviewTask.findUnique.mockResolvedValue(
        taskRow({ document: { title: 'Doc', documentNumber: null, reviewCadence: 'custom' } }),
      );
      await expect(svc.completeTask('task-1', {}, manager, {}, NOW)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('uses an explicit newNextReviewDate when provided (custom cadence)', async () => {
      const { svc, prisma } = build();
      prisma.reviewTask.findUnique
        .mockResolvedValueOnce(
          taskRow({ document: { title: 'Doc', documentNumber: null, reviewCadence: 'custom' } }),
        )
        .mockResolvedValueOnce(taskRow({ status: 'completed' }));
      prisma.reviewTask.update.mockResolvedValue({});
      prisma.document.update.mockResolvedValue({});
      await svc.completeTask('task-1', { newNextReviewDate: '2027-01-15' }, manager, {}, NOW);
      expect(prisma.document.update.mock.calls[0][0].data.nextReviewDate.toISOString()).toBe(
        '2027-01-15T00:00:00.000Z',
      );
    });
  });

  describe('listTasks scoping', () => {
    it('forces a non-manager to only see their own tasks', async () => {
      const { svc, prisma } = build();
      await svc.listTasks({ assignedToId: 'someone-else', mine: false }, staff);
      const where = prisma.reviewTask.findMany.mock.calls[0][0].where;
      // The requested assignedToId is IGNORED; scoped to the caller.
      expect(where.assignedToId).toBe('staff-1');
    });

    it('lets a manager filter by any assignee', async () => {
      const { svc, prisma } = build();
      await svc.listTasks({ assignedToId: 'rev-a', status: 'pending' }, manager);
      const where = prisma.reviewTask.findMany.mock.calls[0][0].where;
      expect(where.assignedToId).toBe('rev-a');
      expect(where.status).toBe('pending');
    });

    it('maps mine=true to the manager\'s own id', async () => {
      const { svc, prisma } = build();
      await svc.listTasks({ mine: true }, manager);
      expect(prisma.reviewTask.findMany.mock.calls[0][0].where.assignedToId).toBe('mgr-1');
    });
  });

  describe('complianceSummary', () => {
    it('computes current/dueSoon/overdue and percentCurrent from counts', async () => {
      const { svc, prisma } = build();
      // total=10, overdue=2, dueSoon=3 => current=5 => 50%.
      prisma.document.count
        .mockResolvedValueOnce(10)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(3);
      const summary = await svc.complianceSummary(NOW, 14);
      expect(summary).toEqual({
        totalDocuments: 10,
        overdue: 2,
        dueSoon: 3,
        current: 5,
        percentCurrent: 50,
      });
      // overdue = nextReviewDate < now; dueSoon window = [now, now+14d].
      const overdueWhere = prisma.document.count.mock.calls[1][0].where;
      expect(overdueWhere.nextReviewDate.lt).toBe(NOW);
      const dueSoonWhere = prisma.document.count.mock.calls[2][0].where;
      expect(dueSoonWhere.nextReviewDate.gte).toBe(NOW);
      expect(dueSoonWhere.nextReviewDate.lte.toISOString()).toBe('2026-07-27T00:00:00.000Z');
    });

    it('reports 100% current when there are no documents', async () => {
      const { svc, prisma } = build();
      prisma.document.count.mockResolvedValue(0);
      const summary = await svc.complianceSummary(NOW);
      expect(summary).toEqual({
        totalDocuments: 0,
        overdue: 0,
        dueSoon: 0,
        current: 0,
        percentCurrent: 100,
      });
    });
  });

  describe('assignReviewer / unassignReviewer', () => {
    it('assigns a reviewer (idempotent) and audits the add', async () => {
      const { svc, prisma, audit } = build();
      prisma.document.findFirst.mockResolvedValue({ id: 'doc-1' });
      prisma.user.findUnique.mockResolvedValue({ id: 'rev-a', name: 'Rev A', email: 'a@x.com' });
      prisma.reviewAssignment.findUnique.mockResolvedValue(null);
      prisma.reviewAssignment.create.mockResolvedValue({
        id: 'asg-1',
        createdAt: new Date('2026-07-10T00:00:00Z'),
      });

      const res = await svc.assignReviewer('doc-1', 'rev-a', manager, { ipAddress: '10.0.0.1' });
      expect(res).toMatchObject({ userId: 'rev-a', name: 'Rev A' });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'review.assigned', metadata: expect.objectContaining({ op: 'add', reviewerId: 'rev-a' }) }),
      );
    });

    it('is idempotent: re-assigning an existing reviewer does not create/audit again', async () => {
      const { svc, prisma, audit } = build();
      prisma.document.findFirst.mockResolvedValue({ id: 'doc-1' });
      prisma.user.findUnique.mockResolvedValue({ id: 'rev-a', name: 'Rev A', email: 'a@x.com' });
      prisma.reviewAssignment.findUnique.mockResolvedValue({
        id: 'asg-1',
        createdAt: new Date('2026-07-10T00:00:00Z'),
      });
      await svc.assignReviewer('doc-1', 'rev-a', manager);
      expect(prisma.reviewAssignment.create).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('400s an unknown reviewer', async () => {
      const { svc, prisma } = build();
      prisma.document.findFirst.mockResolvedValue({ id: 'doc-1' });
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(svc.assignReviewer('doc-1', 'ghost', manager)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('404s assigning against a missing/deleted document', async () => {
      const { svc, prisma } = build();
      prisma.document.findFirst.mockResolvedValue(null);
      await expect(svc.assignReviewer('gone', 'rev-a', manager)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('unassign 404s when the pair is not assigned', async () => {
      const { svc, prisma } = build();
      prisma.reviewAssignment.findUnique.mockResolvedValue(null);
      await expect(svc.unassignReviewer('doc-1', 'rev-a', manager)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('unassign deletes and audits the remove', async () => {
      const { svc, prisma, audit } = build();
      prisma.reviewAssignment.findUnique.mockResolvedValue({ id: 'asg-1' });
      await svc.unassignReviewer('doc-1', 'rev-a', manager, { ipAddress: '10.0.0.9' });
      expect(prisma.reviewAssignment.delete).toHaveBeenCalledWith({ where: { id: 'asg-1' } });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: expect.objectContaining({ op: 'remove' }) }),
      );
    });
  });
});
