import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { UsersService } from './users.service';

describe('UsersService', () => {
  const baseUserRow = {
    id: 'u1',
    email: 'jane@x.com',
    name: 'Jane',
    title: null,
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
    roles: [{ role: { name: 'Manager' } }],
  };

  const makePrisma = () => ({
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    role: { findMany: jest.fn() },
    userRole: { deleteMany: jest.fn(), createMany: jest.fn() },
    refreshToken: { updateMany: jest.fn() },
    $transaction: jest.fn((ops: unknown[]) => Promise.all(ops)),
  });

  const build = (prisma: ReturnType<typeof makePrisma>) => new UsersService(prisma as never);

  describe('create', () => {
    it('hashes the password, links local identity, and NEVER returns the hash', async () => {
      const prisma = makePrisma();
      prisma.user.findUnique.mockResolvedValue(null); // email free
      prisma.role.findMany.mockResolvedValue([{ id: 'r-mgr', name: 'Manager' }]);
      prisma.user.create.mockResolvedValue(baseUserRow);

      const result = await build(prisma).create({
        email: 'JANE@x.com',
        name: 'Jane',
        roles: ['Manager'],
      });

      // Email normalised, temp password generated + returned once.
      expect(result.temporaryPassword).toBeDefined();
      expect(result.temporaryPassword.length).toBeGreaterThan(8);

      const createArg = prisma.user.create.mock.calls[0][0];
      expect(createArg.data.email).toBe('jane@x.com');
      // Stored hash must be an argon2 hash, not the raw password.
      expect(createArg.data.passwordHash).toMatch(/^\$argon2/);
      await expect(
        argon2.verify(createArg.data.passwordHash, result.temporaryPassword),
      ).resolves.toBe(true);
      expect(createArg.data.identities.create).toMatchObject({ provider: 'local' });

      // The public view never carries a hash.
      expect(JSON.stringify(result.user)).not.toContain('argon2');
      expect((result.user as unknown as Record<string, unknown>).passwordHash).toBeUndefined();
      expect(result.user.roles).toEqual(['Manager']);
    });

    it('rejects a duplicate email with 409', async () => {
      const prisma = makePrisma();
      prisma.user.findUnique.mockResolvedValue(baseUserRow);
      await expect(
        build(prisma).create({ email: 'jane@x.com', name: 'Jane' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects unknown role names with 400', async () => {
      const prisma = makePrisma();
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.role.findMany.mockResolvedValue([]); // none found
      await expect(
        build(prisma).create({ email: 'jane@x.com', name: 'Jane', roles: ['Wizard'] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('assignRoles', () => {
    it('replaces the role set atomically', async () => {
      const prisma = makePrisma();
      prisma.user.findUnique
        .mockResolvedValueOnce({ id: 'u1' }) // ensureExists
        .mockResolvedValueOnce(baseUserRow); // get() at the end
      prisma.role.findMany.mockResolvedValue([{ id: 'r-mgr', name: 'Manager' }]);

      await build(prisma).assignRoles('u1', { roles: ['Manager'] });

      expect(prisma.userRole.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
      expect(prisma.userRole.createMany).toHaveBeenCalledWith({
        data: [{ userId: 'u1', roleId: 'r-mgr' }],
        skipDuplicates: true,
      });
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('404s for an unknown user', async () => {
      const prisma = makePrisma();
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(
        build(prisma).assignRoles('ghost', { roles: [] }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('setStatus', () => {
    it('revokes live refresh tokens when disabling', async () => {
      const prisma = makePrisma();
      prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
      prisma.user.update.mockResolvedValue({ ...baseUserRow, status: 'disabled' });

      await build(prisma).setStatus('u1', 'disabled');

      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('does not touch refresh tokens when enabling', async () => {
      const prisma = makePrisma();
      prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
      prisma.user.update.mockResolvedValue({ ...baseUserRow, status: 'active' });

      await build(prisma).setStatus('u1', 'active');
      expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
    });
  });
});
