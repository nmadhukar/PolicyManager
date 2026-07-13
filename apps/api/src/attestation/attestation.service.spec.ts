import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '@policymanager/shared';
import type { RequestContext } from '../audit/request-context';
import { AttestationService } from './attestation.service';

/**
 * Business-behavior tests for the immutable attestation store. Prisma, audit, and
 * the access service are mocked to assert the write shape, the IP/UA capture, the
 * matching `attestation.*` audit, the read (approval chain) filtering/order, and the
 * access-enforced approval-chain surface (SH1).
 */
describe('AttestationService', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const makePrisma = (): any => ({
    attestation: {
      create: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    document: { findFirst: jest.fn() },
  });
  const makeAudit = () => ({ record: jest.fn().mockResolvedValue('ae-1') });
  const makeAccess = () => ({ canAccess: jest.fn().mockResolvedValue(true) });

  const build = (prisma = makePrisma(), audit = makeAudit(), access = makeAccess()) => ({
    prisma,
    audit,
    access,
    svc: new AttestationService(prisma as never, audit as never, access as never),
  });

  const user: AuthUser = {
    id: 'user-1',
    email: 'u@x.com',
    name: 'Dana Reviewer',
    roles: ['Compliance Officer'],
    permissions: ['review.manage'],
    mustChangePassword: false,
  };
  const ctx: RequestContext = { ipAddress: '203.0.113.5', userAgent: 'jest-ua' };

  const createdRow = (over: Record<string, unknown> = {}) => ({
    id: 'att-1',
    documentId: 'doc-1',
    versionId: 'v-1',
    reviewTaskId: null,
    acknowledgmentAssignmentId: null,
    userId: 'user-1',
    action: 'reviewed',
    signatureName: 'Dana Reviewer',
    signatureRole: 'RN',
    comments: 'looks good',
    ipAddress: '203.0.113.5',
    userAgent: 'jest-ua',
    signedAt: new Date('2026-07-13T00:00:00.000Z'),
    createdAt: new Date('2026-07-13T00:00:00.000Z'),
    user: { name: 'Dana Reviewer' },
    version: { versionNumber: 3 },
    ...over,
  });

  describe('record', () => {
    it('writes the sign-off with IP/UA from context and returns the projected item', async () => {
      const { svc, prisma } = build();
      prisma.attestation.create.mockResolvedValue(createdRow());

      const item = await svc.record(
        {
          documentId: 'doc-1',
          versionId: 'v-1',
          action: 'reviewed',
          signatureName: 'Dana Reviewer',
          signatureRole: 'RN',
          comments: 'looks good',
          reviewTaskId: 'task-9',
        },
        user,
        ctx,
      );

      const data = prisma.attestation.create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        documentId: 'doc-1',
        versionId: 'v-1',
        action: 'reviewed',
        userId: 'user-1',
        signatureName: 'Dana Reviewer',
        signatureRole: 'RN',
        reviewTaskId: 'task-9',
        ipAddress: '203.0.113.5',
        userAgent: 'jest-ua',
      });
      expect(item).toMatchObject({ id: 'att-1', action: 'reviewed', versionNumber: 3, userName: 'Dana Reviewer' });
    });

    it('audits the matching attestation.<action> event', async () => {
      const { svc, prisma, audit } = build();
      prisma.attestation.create.mockResolvedValue(createdRow({ action: 'acknowledged' }));
      await svc.record(
        { documentId: 'doc-1', versionId: 'v-1', action: 'acknowledged', signatureName: 'X' },
        user,
        ctx,
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'attestation.acknowledged',
          actorUserId: 'user-1',
          documentId: 'doc-1',
          ipAddress: '203.0.113.5',
        }),
      );
    });

    it('defaults optional relations/fields to undefined (no nulls in the write)', async () => {
      const { svc, prisma } = build();
      prisma.attestation.create.mockResolvedValue(createdRow());
      await svc.record({ documentId: 'doc-1', action: 'approved', signatureName: 'A' }, user, {});
      const data = prisma.attestation.create.mock.calls[0][0].data;
      expect(data.versionId).toBeUndefined();
      expect(data.reviewTaskId).toBeUndefined();
      expect(data.ipAddress).toBeUndefined();
    });
  });

  describe('listApprovalChain', () => {
    it('queries only reviewed/approved, newest first', async () => {
      const { svc, prisma } = build();
      prisma.attestation.findMany.mockResolvedValue([createdRow({ action: 'approved' })]);
      const chain = await svc.listApprovalChain('doc-1');
      const args = prisma.attestation.findMany.mock.calls[0][0];
      expect(args.where).toEqual({ documentId: 'doc-1', action: { in: ['reviewed', 'approved'] } });
      expect(args.orderBy).toEqual({ signedAt: 'desc' });
      expect(chain[0].action).toBe('approved');
    });
  });

  describe('listApprovalChainForDocument (SH1 access-enforced)', () => {
    const accessDoc = { id: 'doc-1', ownerId: 'owner-1', accessLevel: 'confidential', categoryId: null };

    it('returns the chain when the caller has VIEW access', async () => {
      const { svc, prisma, access } = build();
      prisma.document.findFirst.mockResolvedValue(accessDoc);
      prisma.attestation.findMany.mockResolvedValue([createdRow({ action: 'approved' })]);

      const chain = await svc.listApprovalChainForDocument('doc-1', user, ctx);

      expect(prisma.document.findFirst.mock.calls[0][0].where).toEqual({ id: 'doc-1', deletedAt: null });
      expect(access.canAccess).toHaveBeenCalledWith(user, accessDoc, 'view');
      expect(chain[0].action).toBe('approved');
    });

    it('403s + audits access.denied when the caller cannot view (no chain leaked)', async () => {
      const { svc, prisma, access, audit } = build();
      prisma.document.findFirst.mockResolvedValue(accessDoc);
      access.canAccess.mockResolvedValue(false);

      await expect(svc.listApprovalChainForDocument('doc-1', user, ctx)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.attestation.findMany).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'access.denied', documentId: 'doc-1' }),
      );
    });

    it('404s a missing/soft-deleted document', async () => {
      const { svc, prisma } = build();
      prisma.document.findFirst.mockResolvedValue(null);
      await expect(svc.listApprovalChainForDocument('gone', user, ctx)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('immutability contract (AGENTS.md §8)', () => {
    it('exposes NO update or delete surface', () => {
      const { svc } = build();
      const proto = svc as unknown as Record<string, unknown>;
      expect(proto.update).toBeUndefined();
      expect(proto.delete).toBeUndefined();
      expect(proto.remove).toBeUndefined();
    });
  });
});
