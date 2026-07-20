import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '@policymanager/shared';
import { DocumentApprovalService } from './document-approval.service';

/**
 * Business-behavior tests for document approval/publish sign-off. Prisma, audit,
 * access, the attestation store, and acknowledgment are mocked to assert: the
 * approved sign-off, the status transition (approved vs published), the
 * document.approved/published audits, the publish re-trigger, and access denial.
 */
describe('DocumentApprovalService', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const makePrisma = (): any => {
    const prisma: any = {
      document: { findFirst: jest.fn(), update: jest.fn().mockResolvedValue({}) },
      // No prior approval by this user/version by default (see the
      // "already approved" test below for the duplicate case).
      attestation: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    // C6/D4: approve wraps the state change + sign-off in one transaction.
    prisma.$transaction = jest.fn((arg: unknown) =>
      typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(prisma) : Promise.all(arg as unknown[]),
    );
    return prisma;
  };
  const makeAudit = () => ({ record: jest.fn().mockResolvedValue('ae-1') });
  const makeAccess = () => ({ canAccess: jest.fn().mockResolvedValue(true) });
  const makeAttestation = () => ({
    record: jest.fn().mockResolvedValue({ id: 'att-1', action: 'approved' }),
  });
  const makeAck = () => ({ retriggerForVersion: jest.fn().mockResolvedValue(0) });

  const build = (
    prisma = makePrisma(),
    audit = makeAudit(),
    access = makeAccess(),
    attestation = makeAttestation(),
    ack = makeAck(),
  ) => ({
    prisma,
    audit,
    access,
    attestation,
    ack,
    svc: new DocumentApprovalService(
      prisma as never,
      audit as never,
      access as never,
      attestation as never,
      ack as never,
    ),
  });

  const approver: AuthUser = {
    id: 'appr-1',
    email: 'a@x.com',
    name: 'Cleo Approver',
    roles: ['Compliance Officer'],
    permissions: ['document.approve'],
    mustChangePassword: false,
  };

  const docRow = (over: Record<string, unknown> = {}) => ({
    id: 'doc-1',
    ownerId: 'owner-1',
    accessLevel: 'restricted',
    categoryId: null,
    currentVersionId: 'v-2',
    status: 'in_review',
    ...over,
  });

  it('records an approved sign-off, sets status=approved, and audits document.approved', async () => {
    const { svc, prisma, audit, attestation, ack } = build();
    prisma.document.findFirst.mockResolvedValue(docRow());

    const res = await svc.approve('doc-1', { comments: 'LGTM' }, approver, { ipAddress: '10.0.0.1' });

    expect(attestation.record).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: 'doc-1',
        versionId: 'v-2',
        action: 'approved',
        signatureName: 'Cleo Approver', // defaulted
        comments: 'LGTM',
      }),
      approver,
      { ipAddress: '10.0.0.1' },
      expect.anything(), // tx client (C6/D4)
    );
    expect(prisma.document.update).toHaveBeenCalledWith({
      where: { id: 'doc-1' },
      data: { status: 'approved' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'document.approved' }),
    );
    // No publish => no re-trigger.
    expect(ack.retriggerForVersion).not.toHaveBeenCalled();
    expect(res).toMatchObject({ status: 'approved', acknowledgmentsRetriggered: 0 });
  });

  it('publishes (status=published), audits document.published, and re-triggers acknowledgment', async () => {
    const { svc, prisma, audit, ack } = build();
    prisma.document.findFirst.mockResolvedValue(docRow());
    ack.retriggerForVersion.mockResolvedValue(3);

    const res = await svc.approve('doc-1', { publish: true }, approver);

    expect(prisma.document.update).toHaveBeenCalledWith({
      where: { id: 'doc-1' },
      data: { status: 'published' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'document.published' }),
    );
    expect(ack.retriggerForVersion).toHaveBeenCalledWith('doc-1', 'v-2', approver, expect.anything());
    expect(res).toMatchObject({ status: 'published', acknowledgmentsRetriggered: 3 });
  });

  it('honours an explicit signatureName + role', async () => {
    const { svc, prisma, attestation } = build();
    prisma.document.findFirst.mockResolvedValue(docRow());
    await svc.approve('doc-1', { signatureName: 'Dr. C', signatureRole: 'CO' }, approver);
    expect(attestation.record.mock.calls[0][0]).toMatchObject({
      signatureName: 'Dr. C',
      signatureRole: 'CO',
    });
  });

  it('403s (with an access.denied audit) when the approver lacks access', async () => {
    const { svc, prisma, access, audit, attestation } = build();
    prisma.document.findFirst.mockResolvedValue(docRow({ accessLevel: 'confidential' }));
    access.canAccess.mockResolvedValue(false);

    await expect(svc.approve('doc-1', {}, approver)).rejects.toBeInstanceOf(ForbiddenException);
    expect(attestation.record).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'access.denied' }),
    );
  });

  it('400s when the document has no current version to approve', async () => {
    const { svc, prisma } = build();
    prisma.document.findFirst.mockResolvedValue(docRow({ currentVersionId: null }));
    await expect(svc.approve('doc-1', {}, approver)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('404s a missing/deleted document', async () => {
    const { svc, prisma } = build();
    prisma.document.findFirst.mockResolvedValue(null);
    await expect(svc.approve('gone', {}, approver)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('400s when this user already approved the current version, without recording a second sign-off', async () => {
    const { svc, prisma, attestation } = build();
    prisma.document.findFirst.mockResolvedValue(docRow());
    prisma.attestation.findFirst.mockResolvedValue({ id: 'att-existing' });

    await expect(svc.approve('doc-1', {}, approver)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.attestation.findFirst).toHaveBeenCalledWith({
      where: { documentId: 'doc-1', versionId: 'v-2', userId: approver.id, action: 'approved' },
      select: { id: true },
    });
    expect(attestation.record).not.toHaveBeenCalled();
  });

  // RAG Phase 2: publishing best-effort embeds the now-current version so the
  // chatbot can retrieve it. The hook is fire-and-forget and must never make a
  // publish fail. `embedding` is the optional 7th constructor arg (after the
  // optional 6th `notifications`), so we pass notifications=undefined.
  const makeEmbedding = () => ({ embedVersion: jest.fn().mockResolvedValue('done') });
  const buildWithEmbedding = (embedding = makeEmbedding()) => {
    const prisma = makePrisma();
    const audit = makeAudit();
    const access = makeAccess();
    const attestation = makeAttestation();
    const ack = makeAck();
    return {
      prisma,
      audit,
      access,
      attestation,
      ack,
      embedding,
      svc: new DocumentApprovalService(
        prisma as never,
        audit as never,
        access as never,
        attestation as never,
        ack as never,
        undefined, // notifications (6th, optional)
        embedding as never, // embedding (7th, optional)
      ),
    };
  };

  it('triggers embedding for the current version on publish', async () => {
    const { svc, prisma, embedding } = buildWithEmbedding();
    prisma.document.findFirst.mockResolvedValue(docRow());

    await svc.approve('doc-1', { publish: true }, approver);

    // triggerEmbedding fires synchronously (void promise) before approve resolves.
    expect(embedding.embedVersion).toHaveBeenCalledWith('v-2');
  });

  it('does NOT trigger embedding when not publishing', async () => {
    const { svc, prisma, embedding } = buildWithEmbedding();
    prisma.document.findFirst.mockResolvedValue(docRow());

    await svc.approve('doc-1', { publish: false }, approver);

    expect(embedding.embedVersion).not.toHaveBeenCalled();
  });

  it('publish still succeeds when embedding throws (non-blocking)', async () => {
    const embedding = makeEmbedding();
    embedding.embedVersion.mockRejectedValue(new Error('embed down'));
    const { svc, prisma } = buildWithEmbedding(embedding);
    prisma.document.findFirst.mockResolvedValue(docRow());

    // The rejected embedding is swallowed inside triggerEmbedding's .catch —
    // approve must resolve normally with a published result.
    const res = await svc.approve('doc-1', { publish: true }, approver);

    expect(embedding.embedVersion).toHaveBeenCalledWith('v-2');
    expect(res).toMatchObject({ status: 'published' });
  });

  it('works with no embedding service injected', async () => {
    const { svc, prisma } = build(); // no 6th/7th arg
    prisma.document.findFirst.mockResolvedValue(docRow());

    const res = await svc.approve('doc-1', { publish: true }, approver);

    expect(res).toMatchObject({ status: 'published' });
  });

  describe('FINDING-017: document-status guard', () => {
    it('400s approving an archived document instead of silently re-approving it', async () => {
      const { svc, prisma, attestation } = build();
      prisma.document.findFirst.mockResolvedValue(docRow({ status: 'archived' }));

      await expect(svc.approve('doc-1', {}, approver)).rejects.toBeInstanceOf(BadRequestException);
      expect(attestation.record).not.toHaveBeenCalled();
      expect(prisma.document.update).not.toHaveBeenCalled();
    });

    it('400s approving a retired document instead of silently re-publishing it', async () => {
      const { svc, prisma, attestation, ack } = build();
      prisma.document.findFirst.mockResolvedValue(docRow({ status: 'retired' }));

      await expect(svc.approve('doc-1', { publish: true }, approver)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(attestation.record).not.toHaveBeenCalled();
      expect(ack.retriggerForVersion).not.toHaveBeenCalled();
    });

    it('a second authorized approver re-approving an already-published document gets a no-op success, not a duplicate Attestation', async () => {
      const { svc, prisma, attestation, ack, audit } = build();
      prisma.document.findFirst.mockResolvedValue(docRow({ status: 'published' }));
      const priorApproval = {
        id: 'att-prior',
        documentId: 'doc-1',
        versionId: 'v-2',
        version: { versionNumber: 2 },
        reviewTaskId: null,
        acknowledgmentAssignmentId: null,
        userId: 'other-approver',
        user: { name: 'Other Approver' },
        action: 'approved',
        signatureName: 'Other Approver',
        signatureRole: null,
        comments: null,
        ipAddress: null,
        signedAt: new Date('2026-07-01T00:00:00Z'),
      };
      prisma.attestation.findFirst
        .mockResolvedValueOnce(null) // the per-user alreadyApproved check (different user => none)
        .mockResolvedValueOnce(priorApproval); // the published-no-op lookup

      const res = await svc.approve('doc-1', { publish: true }, approver);

      expect(res).toMatchObject({
        documentId: 'doc-1',
        status: 'published',
        acknowledgmentsRetriggered: 0,
        attestation: expect.objectContaining({ id: 'att-prior', action: 'approved' }),
      });
      // No new sign-off, no re-triggered acknowledgment, no re-audit of approve/publish.
      expect(attestation.record).not.toHaveBeenCalled();
      expect(ack.retriggerForVersion).not.toHaveBeenCalled();
      expect(prisma.document.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'document.published' }),
      );
    });
  });
});
