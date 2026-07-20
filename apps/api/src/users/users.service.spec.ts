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
    mustChangePassword: false,
    lockedUntil: null,
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

  const makeAuth = () => ({ issuePasswordReset: jest.fn().mockResolvedValue(undefined) });

  const build = (
    prisma: ReturnType<typeof makePrisma>,
    auth: ReturnType<typeof makeAuth> = makeAuth(),
  ) => new UsersService(prisma as never, auth as never);

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

    it('FINDING-016: rejects a caller-supplied password that fails the password policy', async () => {
      const prisma = makePrisma();
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.role.findMany.mockResolvedValue([]);
      await expect(
        build(prisma).create({ email: 'jane@x.com', name: 'Jane', password: 'alllowercase' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('FINDING-016: accepts a caller-supplied password that passes the policy', async () => {
      const prisma = makePrisma();
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.role.findMany.mockResolvedValue([]);
      prisma.user.create.mockResolvedValue(baseUserRow);

      const result = await build(prisma).create({
        email: 'jane@x.com',
        name: 'Jane',
        password: 'Correct-Horse-9',
      });

      expect(result.temporaryPassword).toBe('Correct-Horse-9');
      const createArg = prisma.user.create.mock.calls[0][0];
      await expect(
        argon2.verify(createArg.data.passwordHash, 'Correct-Horse-9'),
      ).resolves.toBe(true);
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

    it('blocks an admin from disabling their OWN account (self-lockout guard)', async () => {
      const prisma = makePrisma();
      prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
      await expect(
        build(prisma).setStatus('u1', 'disabled', 'u1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe('lockUser / unlockUser', () => {
    it('locks a user, revoking their refresh tokens', async () => {
      const prisma = makePrisma();
      prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
      prisma.user.update.mockResolvedValue({ ...baseUserRow, lockedUntil: new Date('9999-12-31') });

      await build(prisma).lockUser('u1', 'admin-2');

      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      const data = prisma.user.update.mock.calls[0][0].data;
      expect(data.lockedUntil).toBeInstanceOf(Date);
      expect(data.lockedUntil.getTime()).toBeGreaterThan(Date.now());
    });

    it('blocks an admin from locking their OWN account', async () => {
      const prisma = makePrisma();
      prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
      await expect(build(prisma).lockUser('u1', 'u1')).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('unlock clears lockedUntil and resets the failure counter', async () => {
      const prisma = makePrisma();
      prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
      prisma.user.update.mockResolvedValue({ ...baseUserRow });

      await build(prisma).unlockUser('u1');

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { lockedUntil: null, failedLoginAttempts: 0 },
        select: expect.anything(),
      });
    });
  });

  describe('adminResetPassword', () => {
    it('temp mode: sets a fresh hash + mustChangePassword, revokes tokens, returns the temp once', async () => {
      const prisma = makePrisma();
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'jane@x.com', name: 'Jane' });
      prisma.user.update.mockResolvedValue({});

      const result = await build(prisma).adminResetPassword('u1', 'temp');

      expect(result.mode).toBe('temp');
      expect(result.temporaryPassword).toBeDefined();
      const data = prisma.user.update.mock.calls[0][0].data;
      expect(data.passwordHash).toMatch(/^\$argon2/);
      expect(data.mustChangePassword).toBe(true);
      await expect(argon2.verify(data.passwordHash, result.temporaryPassword!)).resolves.toBe(true);
      expect(prisma.refreshToken.updateMany).toHaveBeenCalled();
    });

    it('email mode: delegates to AuthService.issuePasswordReset and discloses no password', async () => {
      const prisma = makePrisma();
      const auth = makeAuth();
      const user = { id: 'u1', email: 'jane@x.com', name: 'Jane' };
      prisma.user.findUnique.mockResolvedValue(user);

      const result = await build(prisma, auth).adminResetPassword('u1', 'email');

      expect(result).toEqual({ mode: 'email', emailed: true });
      expect(auth.issuePasswordReset).toHaveBeenCalledWith(user);
      expect(prisma.user.update).not.toHaveBeenCalled(); // no password set locally
      expect(prisma.refreshToken.updateMany).toHaveBeenCalled();
    });

    it('404s for an unknown user', async () => {
      const prisma = makePrisma();
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(build(prisma).adminResetPassword('ghost', 'temp')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
