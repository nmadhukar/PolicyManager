import type { AuthUser } from '@policymanager/shared';
import type { RequestContext } from '../audit/request-context';
import { AttestationService } from './attestation.service';

/**
 * Business-behavior tests for the immutable attestation store. Prisma + audit are
 * mocked to assert the write shape, the IP/UA capture from request context, the
 * matching `attestation.*` audit, and the read (approval chain) filtering/order.
 */
describe('AttestationService', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const makePrisma = (): any => ({
    attestation: {
      create: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
  });
  const makeAudit = () => ({ record: jest.fn().mockResolvedValue('ae-1') });

  const build = (prisma = makePrisma(), audit = makeAudit()) => ({
    prisma,
    audit,
    svc: new AttestationService(prisma as never, audit as never),
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
