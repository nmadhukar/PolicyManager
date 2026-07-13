import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { AuthService, ttlToMs } from './auth.service';

// `@prisma/client` (pulled in transitively via AuthService -> PrismaService)
// loads the repo `.env` into `process.env` on import, and @nestjs/config's
// ConfigService gives `process.env` PRECEDENCE over the constructor object.
// Without this, JWT_ACCESS_SECRET resolves to the `.env` value at sign time but
// the tests verify with the literals below -> "invalid signature". Pin the env
// so config resolution is hermetic and matches the test's intended secrets.
process.env.JWT_ACCESS_SECRET = 'test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';

/**
 * Business-behavior unit tests for token/redemption + permission resolution.
 * Prisma is mocked; argon2 + JwtService are real (fast enough).
 */
describe('AuthService', () => {
  const config = new ConfigService({
    JWT_ACCESS_SECRET: 'test-access-secret',
    JWT_REFRESH_SECRET: 'test-refresh-secret',
    JWT_ACCESS_TTL: '900s',
    JWT_REFRESH_TTL: '7d',
  });
  const jwt = new JwtService({});

  const makeUserRecord = (overrides: Record<string, unknown> = {}) => ({
    id: 'user-1',
    email: 'admin@policymanager.local',
    name: 'Admin',
    status: 'active',
    passwordHash: undefined as string | undefined,
    roles: [
      {
        role: {
          name: 'Admin',
          permissions: [
            { permission: { key: 'user.manage' } },
            { permission: { key: 'document.read' } },
            { permission: { key: 'document.read' } }, // duplicate on purpose
          ],
        },
      },
    ],
    ...overrides,
  });

  const makePrisma = () => ({
    user: { findUnique: jest.fn() },
    refreshToken: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  });

  const build = (prisma: ReturnType<typeof makePrisma>) =>
    new AuthService(prisma as never, jwt, config);

  describe('ttlToMs', () => {
    it.each([
      ['900s', 900_000],
      ['15m', 900_000],
      ['7d', 604_800_000],
      ['24h', 86_400_000],
      ['500', 500_000],
    ])('parses %s', (input, expected) => {
      expect(ttlToMs(input)).toBe(expected);
    });

    it('throws on garbage', () => {
      expect(() => ttlToMs('nope')).toThrow();
    });
  });

  describe('hashRefreshToken', () => {
    it('is deterministic and hides the raw token', () => {
      const h1 = AuthService.hashRefreshToken('raw-token');
      const h2 = AuthService.hashRefreshToken('raw-token');
      expect(h1).toBe(h2);
      expect(h1).not.toContain('raw-token');
      expect(h1).toHaveLength(64);
    });
  });

  describe('validateCredentials', () => {
    it('resolves an AuthUser with de-duplicated permissions on success', async () => {
      const prisma = makePrisma();
      const hash = await argon2.hash('secret');
      prisma.user.findUnique.mockResolvedValue(makeUserRecord({ passwordHash: hash }));

      const user = await build(prisma).validateCredentials('admin@policymanager.local', 'secret');

      expect(user.id).toBe('user-1');
      expect(user.roles).toEqual(['Admin']);
      expect(user.permissions.sort()).toEqual(['document.read', 'user.manage']);
    });

    it('rejects a wrong password with 401', async () => {
      const prisma = makePrisma();
      const hash = await argon2.hash('secret');
      prisma.user.findUnique.mockResolvedValue(makeUserRecord({ passwordHash: hash }));

      await expect(
        build(prisma).validateCredentials('admin@policymanager.local', 'WRONG'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects an unknown user with 401', async () => {
      const prisma = makePrisma();
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(
        build(prisma).validateCredentials('ghost@x.com', 'x'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects a disabled user even with the right password', async () => {
      const prisma = makePrisma();
      const hash = await argon2.hash('secret');
      prisma.user.findUnique.mockResolvedValue(
        makeUserRecord({ passwordHash: hash, status: 'disabled' }),
      );
      await expect(
        build(prisma).validateCredentials('admin@policymanager.local', 'secret'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('issueTokens', () => {
    it('signs a verifiable access token and persists only the refresh HASH', async () => {
      const prisma = makePrisma();
      prisma.refreshToken.create.mockResolvedValue({});
      const authUser = {
        id: 'user-1',
        email: 'a@b.com',
        name: 'A',
        roles: ['Admin'],
        permissions: ['user.manage'],
      };

      const tokens = await build(prisma).issueTokens(authUser);

      const decoded = jwt.verify(tokens.accessToken, { secret: 'test-access-secret' });
      expect(decoded).toMatchObject({ sub: 'user-1', email: 'a@b.com' });

      expect(prisma.refreshToken.create).toHaveBeenCalledTimes(1);
      const persisted = prisma.refreshToken.create.mock.calls[0][0].data;
      expect(persisted.userId).toBe('user-1');
      expect(persisted.tokenHash).toBe(AuthService.hashRefreshToken(tokens.refreshToken));
      // Raw token is NEVER what we store.
      expect(persisted.tokenHash).not.toBe(tokens.refreshToken);
      expect(persisted.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('refresh (rotation)', () => {
    it('rotates: revokes the old token and issues a new pair', async () => {
      const prisma = makePrisma();
      const raw = 'the-raw-refresh';
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'rt-1',
        userId: 'user-1',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 100_000),
      });
      prisma.user.findUnique.mockResolvedValue(makeUserRecord());
      prisma.refreshToken.update.mockResolvedValue({});
      prisma.refreshToken.create.mockResolvedValue({});

      const result = await build(prisma).refresh(raw);

      expect(prisma.refreshToken.findUnique).toHaveBeenCalledWith({
        where: { tokenHash: AuthService.hashRefreshToken(raw) },
      });
      expect(prisma.refreshToken.update).toHaveBeenCalledWith({
        where: { id: 'rt-1' },
        data: { revokedAt: expect.any(Date) },
      });
      expect(prisma.refreshToken.create).toHaveBeenCalledTimes(1);
      expect(result.user.id).toBe('user-1');
      expect(result.accessToken).toBeDefined();
    });

    it('rejects an already-revoked token (reuse) with 401 and does not rotate', async () => {
      const prisma = makePrisma();
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'rt-1',
        userId: 'user-1',
        revokedAt: new Date(),
        expiresAt: new Date(Date.now() + 100_000),
      });
      await expect(build(prisma).refresh('x')).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.refreshToken.update).not.toHaveBeenCalled();
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('rejects an expired token with 401', async () => {
      const prisma = makePrisma();
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'rt-1',
        userId: 'user-1',
        revokedAt: null,
        expiresAt: new Date(Date.now() - 1),
      });
      await expect(build(prisma).refresh('x')).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects an unknown token with 401', async () => {
      const prisma = makePrisma();
      prisma.refreshToken.findUnique.mockResolvedValue(null);
      await expect(build(prisma).refresh('x')).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('logout', () => {
    it('revokes the matching, not-yet-revoked token', async () => {
      const prisma = makePrisma();
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
      await build(prisma).logout('raw');
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { tokenHash: AuthService.hashRefreshToken('raw'), revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });
  });

  describe('getAuthUser', () => {
    it('returns null for a disabled user', async () => {
      const prisma = makePrisma();
      prisma.user.findUnique.mockResolvedValue(makeUserRecord({ status: 'disabled' }));
      expect(await build(prisma).getAuthUser('user-1')).toBeNull();
    });

    it('resolves roles + de-duplicated permissions for an active user', async () => {
      const prisma = makePrisma();
      prisma.user.findUnique.mockResolvedValue(makeUserRecord());
      const user = await build(prisma).getAuthUser('user-1');
      expect(user?.permissions.sort()).toEqual(['document.read', 'user.manage']);
    });
  });
});
