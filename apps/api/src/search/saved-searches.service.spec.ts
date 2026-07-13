import { ForbiddenException } from '@nestjs/common';
import { PERMISSIONS, type AuthUser } from '@policymanager/shared';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import { SavedSearchesService } from './saved-searches.service';

describe('SavedSearchesService (authorization)', () => {
  const owner: AuthUser = {
    id: 'u1',
    email: 'u1@x.com',
    name: 'Owner',
    roles: ['Staff'],
    permissions: [],
    mustChangePassword: false,
  };
  const manager: AuthUser = {
    id: 'u2',
    email: 'u2@x.com',
    name: 'Manager',
    roles: ['Manager'],
    permissions: [PERMISSIONS.SAVED_SEARCH_MANAGE],
    mustChangePassword: false,
  };

  const row = (over: Record<string, unknown> = {}) => ({
    id: 's1',
    name: 'n',
    ownerId: 'u1',
    scope: 'private',
    roleName: null,
    filters: {},
    sort: null,
    owner: { name: 'Owner' },
    createdAt: new Date('2026-07-13T00:00:00Z'),
    updatedAt: new Date('2026-07-13T00:00:00Z'),
    lastRunAt: null,
    ...over,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const makePrisma = (over: any = {}): any => ({
    savedSearch: {
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(row({ ...data })),
      ),
      update: jest.fn().mockResolvedValue(row()),
      delete: jest.fn().mockResolvedValue(row()),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      ...over.savedSearch,
    },
  });
  const build = (prisma: unknown) =>
    new SavedSearchesService(prisma as PrismaService, { record: jest.fn() } as unknown as AuditService);

  it('sets ownerId from the authenticated user, never the request body', async () => {
    const prisma = makePrisma();
    await build(prisma).create(
      { name: 'Mine', scope: 'private', filters: {}, ownerId: 'attacker' } as never,
      owner,
    );
    expect(prisma.savedSearch.create.mock.calls[0][0].data.ownerId).toBe('u1');
  });

  it('rejects creating a SHARED search without saved_search.manage', async () => {
    await expect(
      build(makePrisma()).create({ name: 'Team', scope: 'global', filters: {} } as never, owner),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('forbids a manage-holder from mutating another user\'s PRIVATE search (IDOR)', async () => {
    const prisma = makePrisma({
      savedSearch: { findUnique: jest.fn().mockResolvedValue(row({ ownerId: 'u1', scope: 'private' })) },
    });
    const svc = build(prisma);
    await expect(
      svc.update('s1', { name: 'x', scope: 'private', filters: {} } as never, manager),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.remove('s1', manager)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.savedSearch.update).not.toHaveBeenCalled();
    expect(prisma.savedSearch.delete).not.toHaveBeenCalled();
  });

  it('allows a manage-holder to delete a SHARED search they do not own', async () => {
    const prisma = makePrisma({
      savedSearch: {
        findUnique: jest.fn().mockResolvedValue(row({ ownerId: 'u1', scope: 'global' })),
        delete: jest.fn().mockResolvedValue(row()),
      },
    });
    await expect(build(prisma).remove('s1', manager)).resolves.toBeUndefined();
    expect(prisma.savedSearch.delete).toHaveBeenCalled();
  });

  it('lets an owner delete their own private search', async () => {
    const prisma = makePrisma({
      savedSearch: {
        findUnique: jest.fn().mockResolvedValue(row({ ownerId: 'u1', scope: 'private' })),
        delete: jest.fn().mockResolvedValue(row()),
      },
    });
    await expect(build(prisma).remove('s1', owner)).resolves.toBeUndefined();
    expect(prisma.savedSearch.delete).toHaveBeenCalled();
  });
});
