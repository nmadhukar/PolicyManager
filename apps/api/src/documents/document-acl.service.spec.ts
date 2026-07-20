import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthUser } from '@policymanager/shared';
import { DocumentAclService } from './document-acl.service';

/** A P2002 error shaped like the real Prisma runtime error for this test's purposes. */
function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makePrisma = (): any => ({
  document: { findFirst: jest.fn() },
  documentAcl: {
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn().mockResolvedValue(null),
    create: jest.fn(),
    delete: jest.fn(),
  },
  role: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
  user: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
});

const makeAccess = () => ({ assertCanAccess: jest.fn().mockResolvedValue(undefined) });
const makeAudit = () => ({ record: jest.fn().mockResolvedValue('ae-1') });

const build = (p = makePrisma(), a = makeAccess(), au = makeAudit()) => ({
  prisma: p,
  access: a,
  audit: au,
  svc: new DocumentAclService(p as never, a as never, au as never),
});

const user: AuthUser = {
  id: 'admin-1',
  email: 'a@x.com',
  name: 'Admin',
  roles: ['Admin'],
  permissions: ['document.write'],
  mustChangePassword: false,
};

const activeDoc = { id: 'doc-1', ownerId: 'o', accessLevel: 'confidential', categoryId: null };

const aclRow = (over: Record<string, unknown> = {}) => ({
  id: 'acl-1',
  documentId: 'doc-1',
  categoryId: null,
  principalType: 'user',
  principalId: 'u-2',
  permission: 'view',
  createdAt: new Date('2026-02-01T00:00:00Z'),
  createdBy: { name: 'Admin' },
  ...over,
});

describe('DocumentAclService.list', () => {
  it('404s for a missing/soft-deleted document', async () => {
    const { svc, prisma } = build();
    prisma.document.findFirst.mockResolvedValue(null);
    await expect(svc.list('gone', user)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('enforces edit access then resolves principal names (user + role)', async () => {
    const { svc, prisma, access } = build();
    prisma.document.findFirst.mockResolvedValue(activeDoc);
    prisma.documentAcl.findMany.mockResolvedValue([
      aclRow({ id: 'a1', principalType: 'user', principalId: 'u-2' }),
      aclRow({ id: 'a2', principalType: 'role', principalId: 'r-9', permission: 'edit' }),
    ]);
    prisma.user.findMany.mockResolvedValue([{ id: 'u-2', name: 'Jane' }]);
    prisma.role.findMany.mockResolvedValue([{ id: 'r-9', name: 'Managers' }]);

    const grants = await svc.list('doc-1', user);

    expect(access.assertCanAccess).toHaveBeenCalledWith(user, activeDoc, 'edit');
    expect(grants).toHaveLength(2);
    expect(grants[0]).toMatchObject({ principalId: 'u-2', principalName: 'Jane' });
    expect(grants[1]).toMatchObject({ principalId: 'r-9', principalName: 'Managers', permission: 'edit' });
  });

  it('propagates a 403 from the access check', async () => {
    const { svc, prisma, access } = build();
    prisma.document.findFirst.mockResolvedValue(activeDoc);
    access.assertCanAccess.mockRejectedValue(new ForbiddenException());
    await expect(svc.list('doc-1', user)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('DocumentAclService.add', () => {
  it('validates an unknown role principal with 400 (no write)', async () => {
    const { svc, prisma } = build();
    prisma.document.findFirst.mockResolvedValue(activeDoc);
    prisma.role.findUnique.mockResolvedValue(null);
    await expect(
      svc.add('doc-1', { principalType: 'role', principalId: 'r-x', permission: 'view' }, user),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.documentAcl.create).not.toHaveBeenCalled();
  });

  it('creates a grant and writes an acl.changed audit event', async () => {
    const { svc, prisma, audit } = build();
    prisma.document.findFirst.mockResolvedValue(activeDoc);
    prisma.user.findUnique.mockResolvedValue({ id: 'u-2' });
    prisma.documentAcl.create.mockResolvedValue(aclRow());
    prisma.user.findMany.mockResolvedValue([{ id: 'u-2', name: 'Jane' }]);

    const grant = await svc.add(
      'doc-1',
      { principalType: 'user', principalId: 'u-2', permission: 'view' },
      user,
      { ipAddress: '10.0.0.1', userAgent: 'jest' },
    );

    const created = prisma.documentAcl.create.mock.calls[0][0].data;
    expect(created).toMatchObject({
      documentId: 'doc-1',
      principalType: 'user',
      principalId: 'u-2',
      permission: 'view',
      createdById: 'admin-1',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'acl.changed',
        actorUserId: 'admin-1',
        documentId: 'doc-1',
        ipAddress: '10.0.0.1',
        metadata: expect.objectContaining({ op: 'add', principalId: 'u-2' }),
      }),
    );
    expect(grant.principalName).toBe('Jane');
  });

  it('is idempotent: an identical grant is returned without a second write/audit', async () => {
    const { svc, prisma, audit } = build();
    prisma.document.findFirst.mockResolvedValue(activeDoc);
    prisma.user.findUnique.mockResolvedValue({ id: 'u-2' });
    prisma.documentAcl.findFirst.mockResolvedValue(aclRow());
    prisma.user.findMany.mockResolvedValue([{ id: 'u-2', name: 'Jane' }]);

    await svc.add('doc-1', { principalType: 'user', principalId: 'u-2', permission: 'view' }, user);

    expect(prisma.documentAcl.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('FINDING-011: a lost race (P2002 from the partial unique index) re-fetches and returns the winner, without a duplicate audit', async () => {
    const { svc, prisma, audit } = build();
    prisma.document.findFirst.mockResolvedValue(activeDoc);
    prisma.user.findUnique.mockResolvedValue({ id: 'u-2' });
    prisma.user.findMany.mockResolvedValue([{ id: 'u-2', name: 'Jane' }]);
    // Pre-check finds nothing (both concurrent callers pass it)...
    prisma.documentAcl.findFirst
      .mockResolvedValueOnce(null) // pre-check
      .mockResolvedValueOnce(aclRow()); // post-P2002 re-fetch finds the winner's row
    // ...then create() loses the race to the DB-level partial unique index.
    prisma.documentAcl.create.mockRejectedValue(p2002());

    const grant = await svc.add(
      'doc-1',
      { principalType: 'user', principalId: 'u-2', permission: 'view' },
      user,
    );

    expect(grant).toMatchObject({ id: 'acl-1', principalId: 'u-2', principalName: 'Jane' });
    // The loser must not record a second acl.changed audit for a grant it didn't create.
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('FINDING-011: re-throws a P2002 if the post-race re-fetch still finds nothing', async () => {
    const { svc, prisma } = build();
    prisma.document.findFirst.mockResolvedValue(activeDoc);
    prisma.user.findUnique.mockResolvedValue({ id: 'u-2' });
    prisma.documentAcl.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null); // still nothing — should not happen, but must not silently swallow
    prisma.documentAcl.create.mockRejectedValue(p2002());

    await expect(
      svc.add('doc-1', { principalType: 'user', principalId: 'u-2', permission: 'view' }, user),
    ).rejects.toThrow();
  });

  it('propagates a non-P2002 error from create() unchanged', async () => {
    const { svc, prisma } = build();
    prisma.document.findFirst.mockResolvedValue(activeDoc);
    prisma.user.findUnique.mockResolvedValue({ id: 'u-2' });
    prisma.documentAcl.findFirst.mockResolvedValue(null);
    prisma.documentAcl.create.mockRejectedValue(new Error('connection lost'));

    await expect(
      svc.add('doc-1', { principalType: 'user', principalId: 'u-2', permission: 'view' }, user),
    ).rejects.toThrow('connection lost');
  });
});

describe('DocumentAclService.remove', () => {
  it('404s when the grant is not under the document (no delete/audit)', async () => {
    const { svc, prisma, audit } = build();
    prisma.document.findFirst.mockResolvedValue(activeDoc);
    prisma.documentAcl.findFirst.mockResolvedValue(null);
    await expect(svc.remove('doc-1', 'acl-x', user)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.documentAcl.delete).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('deletes the grant and writes an acl.changed (remove) audit event', async () => {
    const { svc, prisma, audit } = build();
    prisma.document.findFirst.mockResolvedValue(activeDoc);
    prisma.documentAcl.findFirst.mockResolvedValue({
      id: 'acl-1',
      principalType: 'user',
      principalId: 'u-2',
      permission: 'view',
    });

    await svc.remove('doc-1', 'acl-1', user, { ipAddress: '10.0.0.2' });

    expect(prisma.documentAcl.delete).toHaveBeenCalledWith({ where: { id: 'acl-1' } });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'acl.changed',
        metadata: expect.objectContaining({ op: 'remove', principalId: 'u-2' }),
      }),
    );
  });
});
