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
  const makePrisma = (): any => ({
    document: { findFirst: jest.fn(), update: jest.fn().mockResolvedValue({}) },
  });
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
});
