import { ForbiddenException } from '@nestjs/common';
import type { AuthUser } from '@policymanager/shared';
import { AccessDocument, DocumentAccessService } from './document-access.service';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makePrisma = (): any => ({
  userRole: { findMany: jest.fn().mockResolvedValue([]) },
  documentAcl: { count: jest.fn().mockResolvedValue(0) },
});

const build = (p = makePrisma()) => ({ prisma: p, svc: new DocumentAccessService(p as never) });

/** AuthUser factory. `roles`/`permissions` drive the two authorization gates. */
const user = (over: Partial<AuthUser> = {}): AuthUser => ({
  id: 'u-1',
  email: 'u@x.com',
  name: 'U',
  roles: ['Staff'],
  permissions: ['document.read'],
  mustChangePassword: false,
  ...over,
});

const doc = (over: Partial<AccessDocument> = {}): AccessDocument => ({
  id: 'doc-1',
  ownerId: 'owner-9',
  accessLevel: 'restricted',
  categoryId: null,
  ...over,
});

const plainReader = () => user({ id: 'reader', permissions: ['document.read'], roles: ['Staff'] });
const writer = () =>
  user({ id: 'writer', permissions: ['document.read', 'document.write'], roles: ['Manager'] });
const approver = () =>
  user({
    id: 'approver',
    permissions: ['document.read', 'document.write', 'document.approve'],
    roles: ['Compliance Officer'],
  });
const admin = () =>
  user({
    id: 'admin',
    roles: ['Admin'],
    permissions: [
      'document.read',
      'document.write',
      'document.approve',
      'user.manage',
      'audit.read',
    ],
  });

describe('DocumentAccessService.requiredPermission', () => {
  it('maps each action to its RBAC permission', () => {
    expect(DocumentAccessService.requiredPermission('view')).toBe('document.read');
    expect(DocumentAccessService.requiredPermission('download')).toBe('document.read');
    expect(DocumentAccessService.requiredPermission('edit')).toBe('document.write');
    expect(DocumentAccessService.requiredPermission('approve')).toBe('document.approve');
  });
});

describe('DocumentAccessService.canAccess — RBAC gate', () => {
  it('denies view/download without document.read', async () => {
    const { svc } = build();
    const u = user({ permissions: [] });
    expect(await svc.canAccess(u, doc({ accessLevel: 'public' }), 'view')).toBe(false);
    expect(await svc.canAccess(u, doc({ accessLevel: 'public' }), 'download')).toBe(false);
  });

  it('denies edit without document.write even for a reader', async () => {
    const { svc } = build();
    expect(await svc.canAccess(plainReader(), doc({ accessLevel: 'public' }), 'edit')).toBe(false);
  });

  it('denies approve without document.approve', async () => {
    const { svc } = build();
    expect(await svc.canAccess(writer(), doc({ accessLevel: 'public' }), 'approve')).toBe(false);
  });
});

describe('DocumentAccessService.canAccess — public & restricted', () => {
  for (const level of ['public', 'restricted'] as const) {
    it(`${level}: a plain reader can view + download`, async () => {
      const { svc } = build();
      expect(await svc.canAccess(plainReader(), doc({ accessLevel: level }), 'view')).toBe(true);
      expect(await svc.canAccess(plainReader(), doc({ accessLevel: level }), 'download')).toBe(true);
    });
    it(`${level}: a writer can edit; an approver can approve`, async () => {
      const { svc } = build();
      expect(await svc.canAccess(writer(), doc({ accessLevel: level }), 'edit')).toBe(true);
      expect(await svc.canAccess(approver(), doc({ accessLevel: level }), 'approve')).toBe(true);
    });
    it(`${level}: never consults the ACL table (no confidential lookup)`, async () => {
      const { svc, prisma } = build();
      await svc.canAccess(plainReader(), doc({ accessLevel: level }), 'view');
      expect(prisma.documentAcl.count).not.toHaveBeenCalled();
    });
  }
});

describe('DocumentAccessService.canAccess — confidential', () => {
  const confidential = (over: Partial<AccessDocument> = {}) =>
    doc({ accessLevel: 'confidential', ...over });

  it('DENIES a plain reader with NO grant (document.read is not enough)', async () => {
    const { svc, prisma } = build(); // documentAcl.count defaults to 0
    expect(await svc.canAccess(plainReader(), confidential(), 'view')).toBe(false);
    expect(prisma.documentAcl.count).toHaveBeenCalled();
  });

  it('ALLOWS the owner (owner bypass) to view', async () => {
    const { svc, prisma } = build();
    const owner = plainReader();
    expect(await svc.canAccess(owner, confidential({ ownerId: owner.id }), 'view')).toBe(true);
    // Owner short-circuits before any ACL lookup.
    expect(prisma.documentAcl.count).not.toHaveBeenCalled();
  });

  it('ALLOWS an Admin to view without a grant', async () => {
    const { svc, prisma } = build();
    expect(await svc.canAccess(admin(), confidential(), 'view')).toBe(true);
    expect(prisma.documentAcl.count).not.toHaveBeenCalled();
  });

  it('ALLOWS a reader who has an ACL grant (user or role) to view AND download', async () => {
    const { svc, prisma } = build();
    prisma.documentAcl.count.mockResolvedValue(1); // a matching grant exists
    expect(await svc.canAccess(plainReader(), confidential(), 'view')).toBe(true);
    expect(await svc.canAccess(plainReader(), confidential(), 'download')).toBe(true);
  });

  it('scopes the ACL lookup to the document AND its category, matching user or roles', async () => {
    const { svc, prisma } = build();
    prisma.userRole.findMany.mockResolvedValue([{ roleId: 'r-1' }, { roleId: 'r-2' }]);
    prisma.documentAcl.count.mockResolvedValue(1);

    await svc.canAccess(plainReader(), confidential({ categoryId: 'cat-1' }), 'view');

    const where = prisma.documentAcl.count.mock.calls[0][0].where;
    expect(where.AND[0].OR).toEqual([{ documentId: 'doc-1' }, { categoryId: 'cat-1' }]);
    expect(where.AND[1].OR).toEqual([
      { principalType: 'user', principalId: 'reader' },
      { principalType: 'role', principalId: { in: ['r-1', 'r-2'] } },
    ]);
  });

  it('edit on confidential requires BOTH document.write AND a grant/owner/admin', async () => {
    const { svc, prisma } = build();
    // A writer with a grant can edit.
    prisma.documentAcl.count.mockResolvedValue(1);
    expect(await svc.canAccess(writer(), confidential(), 'edit')).toBe(true);
    // A writer with NO grant (and not owner/admin) cannot edit.
    prisma.documentAcl.count.mockResolvedValue(0);
    expect(await svc.canAccess(writer(), confidential(), 'edit')).toBe(false);
    // A reader with a grant still cannot edit (no document.write).
    prisma.documentAcl.count.mockResolvedValue(1);
    expect(await svc.canAccess(plainReader(), confidential(), 'edit')).toBe(false);
  });
});

describe('DocumentAccessService.assertCanAccess', () => {
  it('resolves when allowed, throws 403 when denied', async () => {
    const { svc } = build();
    await expect(
      svc.assertCanAccess(plainReader(), doc({ accessLevel: 'public' }), 'view'),
    ).resolves.toBeUndefined();
    await expect(
      svc.assertCanAccess(plainReader(), doc({ accessLevel: 'confidential' }), 'view'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('DocumentAccessService.buildListWhere', () => {
  it('is empty for an Admin (sees everything)', async () => {
    const { svc, prisma } = build();
    expect(await svc.buildListWhere(admin())).toEqual({});
    expect(prisma.userRole.findMany).not.toHaveBeenCalled();
  });

  it('filters confidential docs to owner/user-grant/role-grant/category-grant', async () => {
    const { svc, prisma } = build();
    prisma.userRole.findMany.mockResolvedValue([{ roleId: 'r-9' }]);

    const where = await svc.buildListWhere(plainReader());

    expect(where.OR).toEqual([
      { accessLevel: { not: 'confidential' } },
      { accessLevel: 'confidential', ownerId: 'reader' },
      {
        accessLevel: 'confidential',
        acls: {
          some: {
            OR: [
              { principalType: 'user', principalId: 'reader' },
              { principalType: 'role', principalId: { in: ['r-9'] } },
            ],
          },
        },
      },
      {
        accessLevel: 'confidential',
        category: {
          acls: {
            some: {
              OR: [
                { principalType: 'user', principalId: 'reader' },
                { principalType: 'role', principalId: { in: ['r-9'] } },
              ],
            },
          },
        },
      },
    ]);
  });
});
