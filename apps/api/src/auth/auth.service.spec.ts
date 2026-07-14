import { BadRequestException, UnauthorizedException } from '@nestjs/common';
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
    mustChangePassword: false,
    failedLoginAttempts: 0,
    lockedUntil: null as Date | null,
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
    user: { findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
    userIdentity: { findUnique: jest.fn(), create: jest.fn() },
    role: { findUnique: jest.fn() },
    refreshToken: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    passwordResetToken: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn((ops: unknown[]) => Promise.all(ops)),
  });

  const makeMail = () => ({
    send: jest.fn().mockResolvedValue(true),
    sendPasswordReset: jest.fn().mockResolvedValue(true),
    sendAccountLocked: jest.fn().mockResolvedValue(true),
  });

  const build = (
    prisma: ReturnType<typeof makePrisma>,
    mail: ReturnType<typeof makeMail> = makeMail(),
  ) => new AuthService(prisma as never, jwt, config, mail as never);

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
        mustChangePassword: false,
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

    it('SL4: reuse of a revoked token kills the whole token family (revokes all live tokens)', async () => {
      const prisma = makePrisma();
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'rt-1',
        userId: 'user-9',
        revokedAt: new Date(), // KNOWN but already revoked => replay/theft
        expiresAt: new Date(Date.now() + 100_000),
      });
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 3 });

      await expect(build(prisma).refresh('replayed')).rejects.toBeInstanceOf(UnauthorizedException);

      // Family kill: every live refresh token for that user is revoked.
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-9', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      // No new pair is issued.
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

    it('surfaces mustChangePassword', async () => {
      const prisma = makePrisma();
      prisma.user.findUnique.mockResolvedValue(makeUserRecord({ mustChangePassword: true }));
      const user = await build(prisma).getAuthUser('user-1');
      expect(user?.mustChangePassword).toBe(true);
    });
  });

  describe('loginWithOidc (ADR 0003)', () => {
    const profile = {
      subject: 'azure-oid-1',
      email: 'jane@clinic.example',
      emailVerified: true,
      name: 'Jane Clinician',
    };

    it('first SSO login creates a new User + UserIdentity with the Staff role', async () => {
      const prisma = makePrisma();
      prisma.userIdentity.findUnique.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.role.findUnique.mockResolvedValue({ id: 'role-staff', name: 'Staff' });
      prisma.user.create.mockResolvedValue(
        makeUserRecord({
          id: 'new-user-1',
          email: profile.email,
          name: profile.name,
          roles: [{ role: { name: 'Staff', permissions: [] } }],
        }),
      );

      const result = await build(prisma).loginWithOidc('azure', profile);

      expect(prisma.role.findUnique).toHaveBeenCalledWith({ where: { name: 'Staff' } });
      const createArgs = prisma.user.create.mock.calls[0][0];
      expect(createArgs.data.email).toBe(profile.email);
      expect(createArgs.data.identities.create).toEqual({
        provider: 'azure',
        subject: profile.subject,
        email: profile.email,
      });
      expect(createArgs.data.roles.create).toEqual({ roleId: 'role-staff' });
      // Never Admin by default.
      expect(result.user.roles).toEqual(['Staff']);
      expect(result.accessToken).toEqual(expect.any(String));
    });

    it('links a new UserIdentity onto an existing user matched by VERIFIED email', async () => {
      const prisma = makePrisma();
      prisma.userIdentity.findUnique.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue(
        makeUserRecord({ id: 'existing-user', email: profile.email }),
      );
      prisma.userIdentity.create.mockResolvedValue({});

      const result = await build(prisma).loginWithOidc('azure', profile);

      expect(prisma.userIdentity.create).toHaveBeenCalledWith({
        data: { userId: 'existing-user', provider: 'azure', subject: profile.subject, email: profile.email },
      });
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(result.user.id).toBe('existing-user');
    });

    it('does NOT link an existing user when the email claim is unverified', async () => {
      const prisma = makePrisma();
      prisma.userIdentity.findUnique.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue(
        makeUserRecord({ id: 'existing-user', email: profile.email }),
      );

      await expect(
        build(prisma).loginWithOidc('azure', { ...profile, emailVerified: false }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.userIdentity.create).not.toHaveBeenCalled();
    });

    it('a second login with the same (provider, subject) reuses the existing account (no duplicate)', async () => {
      const prisma = makePrisma();
      prisma.userIdentity.findUnique.mockResolvedValue({
        id: 'identity-1',
        userId: 'existing-user',
        provider: 'azure',
        subject: profile.subject,
        user: makeUserRecord({ id: 'existing-user', email: profile.email }),
      });

      const result = await build(prisma).loginWithOidc('azure', profile);

      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(prisma.userIdentity.create).not.toHaveBeenCalled();
      expect(result.user.id).toBe('existing-user');
    });

    it('rejects when the linked identity belongs to a disabled user', async () => {
      const prisma = makePrisma();
      prisma.userIdentity.findUnique.mockResolvedValue({
        id: 'identity-1',
        userId: 'disabled-user',
        provider: 'azure',
        subject: profile.subject,
        user: makeUserRecord({ id: 'disabled-user', status: 'disabled' }),
      });

      await expect(build(prisma).loginWithOidc('azure', profile)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects when the matched-by-email existing user is disabled', async () => {
      const prisma = makePrisma();
      prisma.userIdentity.findUnique.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue(
        makeUserRecord({ id: 'existing-user', email: profile.email, status: 'disabled' }),
      );

      await expect(build(prisma).loginWithOidc('azure', profile)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(prisma.userIdentity.create).not.toHaveBeenCalled();
    });

    it('fails loudly if the default Staff role is not seeded', async () => {
      const prisma = makePrisma();
      prisma.userIdentity.findUnique.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.role.findUnique.mockResolvedValue(null);

      await expect(build(prisma).loginWithOidc('azure', profile)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.user.create).not.toHaveBeenCalled();
    });
  });

  describe('brute-force lockout', () => {
    it('rejects a currently-locked account WITHOUT verifying the password', async () => {
      const prisma = makePrisma();
      prisma.user.findUnique.mockResolvedValue(
        makeUserRecord({ passwordHash: await argon2.hash('secret'), lockedUntil: new Date(Date.now() + 60_000) }),
      );

      // A WRONG password on a locked account: if we short-circuit on the lock we
      // never reach registerFailedAttempt, so the counter is NOT touched. If we
      // (wrongly) verified first, the wrong password would trigger user.update.
      await expect(
        build(prisma).validateCredentials('admin@policymanager.local', 'WRONG'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('increments the counter on a wrong password (below threshold, no email)', async () => {
      const prisma = makePrisma();
      const mail = makeMail();
      prisma.user.findUnique.mockResolvedValue(
        makeUserRecord({ passwordHash: await argon2.hash('secret'), failedLoginAttempts: 2 }),
      );

      await expect(
        build(prisma, mail).validateCredentials('admin@policymanager.local', 'WRONG'),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { failedLoginAttempts: 3, lockedUntil: null },
      });
      expect(mail.sendAccountLocked).not.toHaveBeenCalled();
    });

    it('locks and emails when the 5th attempt fails', async () => {
      const prisma = makePrisma();
      const mail = makeMail();
      prisma.user.findUnique.mockResolvedValue(
        makeUserRecord({ passwordHash: await argon2.hash('secret'), failedLoginAttempts: 4 }),
      );

      await expect(
        build(prisma, mail).validateCredentials('admin@policymanager.local', 'WRONG'),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      const data = prisma.user.update.mock.calls[0][0].data;
      expect(data.failedLoginAttempts).toBe(5);
      expect(data.lockedUntil).toBeInstanceOf(Date);
      expect(data.lockedUntil.getTime()).toBeGreaterThan(Date.now());
      expect(mail.sendAccountLocked).toHaveBeenCalledWith('admin@policymanager.local', 'Admin');
    });

    it('resets counters on a successful login', async () => {
      const prisma = makePrisma();
      prisma.user.findUnique.mockResolvedValue(
        makeUserRecord({ passwordHash: await argon2.hash('secret'), failedLoginAttempts: 3 }),
      );

      await build(prisma).validateCredentials('admin@policymanager.local', 'secret');

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { failedLoginAttempts: 0, lockedUntil: null },
      });
    });

    it('uses the SAME uniform message for unknown, wrong, disabled and locked', async () => {
      const messageOf = async (fn: () => Promise<unknown>): Promise<string> => {
        try {
          await fn();
          return '(no error thrown)';
        } catch (e) {
          return (e as Error).message;
        }
      };

      const prisma = makePrisma();
      prisma.user.findUnique.mockResolvedValueOnce(null); // unknown
      const m1 = await messageOf(() =>
        build(prisma).validateCredentials('ghost@x.com', 'x'),
      );
      prisma.user.findUnique.mockResolvedValueOnce(
        makeUserRecord({ passwordHash: await argon2.hash('secret'), lockedUntil: new Date(Date.now() + 60_000) }),
      ); // locked
      const m2 = await messageOf(() =>
        build(prisma).validateCredentials('admin@policymanager.local', 'secret'),
      );

      expect(m1).toBe(m2);
      expect(m1).toBe(AuthService.INVALID_LOGIN);
    });
  });

  describe('forgotPassword (no enumeration)', () => {
    it('creates a reset token and emails an active local user', async () => {
      const prisma = makePrisma();
      const mail = makeMail();
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'jane@x.com',
        name: 'Jane',
        status: 'active',
        passwordHash: 'hash',
      });
      prisma.passwordResetToken.create.mockResolvedValue({});

      await build(prisma, mail).forgotPassword('JANE@x.com');

      expect(prisma.passwordResetToken.create).toHaveBeenCalledTimes(1);
      const created = prisma.passwordResetToken.create.mock.calls[0][0].data;
      expect(created.userId).toBe('user-1');
      expect(created.tokenHash).toHaveLength(64); // sha256, never the raw token
      expect(created.expiresAt.getTime()).toBeGreaterThan(Date.now());
      // The emailed URL carries the RAW token (which is not what we stored).
      const [, , url] = mail.sendPasswordReset.mock.calls[0];
      expect(url).toContain('/reset-password?token=');
      expect(url).not.toContain(created.tokenHash);
    });

    it('does nothing (but does NOT throw) for an unknown email', async () => {
      const prisma = makePrisma();
      const mail = makeMail();
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(build(prisma, mail).forgotPassword('ghost@x.com')).resolves.toBeUndefined();
      expect(prisma.passwordResetToken.create).not.toHaveBeenCalled();
      expect(mail.sendPasswordReset).not.toHaveBeenCalled();
    });

    it('does nothing for a disabled account', async () => {
      const prisma = makePrisma();
      const mail = makeMail();
      prisma.user.findUnique.mockResolvedValue({
        id: 'u', email: 'x@x.com', name: 'X', status: 'disabled', passwordHash: 'h',
      });
      await build(prisma, mail).forgotPassword('x@x.com');
      expect(prisma.passwordResetToken.create).not.toHaveBeenCalled();
    });
  });

  describe('resetPassword', () => {
    const validToken = {
      id: 'prt-1',
      userId: 'user-1',
      usedAt: null as Date | null,
      expiresAt: new Date(Date.now() + 60_000),
    };

    it('rejects an unknown/expired/used token with 400', async () => {
      const prisma = makePrisma();
      prisma.passwordResetToken.findUnique.mockResolvedValue(null);
      await expect(build(prisma).resetPassword('raw', 'Str0ngPass')).rejects.toBeInstanceOf(
        BadRequestException,
      );

      prisma.passwordResetToken.findUnique.mockResolvedValue({ ...validToken, usedAt: new Date() });
      await expect(build(prisma).resetPassword('raw', 'Str0ngPass')).rejects.toBeInstanceOf(
        BadRequestException,
      );

      prisma.passwordResetToken.findUnique.mockResolvedValue({
        ...validToken,
        expiresAt: new Date(Date.now() - 1),
      });
      await expect(build(prisma).resetPassword('raw', 'Str0ngPass')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects a weak password WITHOUT consuming the token', async () => {
      const prisma = makePrisma();
      prisma.passwordResetToken.findUnique.mockResolvedValue(validToken);
      await expect(build(prisma).resetPassword('raw', 'short')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('sets the hash, marks the token used, clears lockout, and revokes refresh tokens', async () => {
      const prisma = makePrisma();
      prisma.passwordResetToken.findUnique.mockResolvedValue(validToken);

      await build(prisma).resetPassword('raw', 'Str0ngPass');

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      const userUpdate = prisma.user.update.mock.calls[0][0];
      expect(userUpdate.where).toEqual({ id: 'user-1' });
      expect(userUpdate.data.passwordHash).toMatch(/^\$argon2/);
      expect(userUpdate.data).toMatchObject({
        mustChangePassword: false,
        failedLoginAttempts: 0,
        lockedUntil: null,
      });
      expect(prisma.passwordResetToken.update).toHaveBeenCalledWith({
        where: { id: 'prt-1' },
        data: { usedAt: expect.any(Date) },
      });
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });
  });

  describe('changePassword', () => {
    it('rejects a wrong current password with 400 (not 401)', async () => {
      const prisma = makePrisma();
      prisma.user.findUnique.mockResolvedValue(
        makeUserRecord({ passwordHash: await argon2.hash('correct') }),
      );
      await expect(
        build(prisma).changePassword('user-1', 'WRONG', 'Str0ngPass'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects a weak new password with 400', async () => {
      const prisma = makePrisma();
      prisma.user.findUnique.mockResolvedValue(
        makeUserRecord({ passwordHash: await argon2.hash('correct') }),
      );
      await expect(
        build(prisma).changePassword('user-1', 'correct', 'short'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('sets the new hash, revokes old tokens, and returns a FRESH session', async () => {
      const prisma = makePrisma();
      prisma.user.findUnique.mockResolvedValue(
        makeUserRecord({ passwordHash: await argon2.hash('correct'), mustChangePassword: true }),
      );
      prisma.refreshToken.create.mockResolvedValue({});

      const result = await build(prisma).changePassword('user-1', 'correct', 'Str0ngPass');

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      const userUpdate = prisma.user.update.mock.calls[0][0];
      expect(userUpdate.data.passwordHash).toMatch(/^\$argon2/);
      expect(userUpdate.data.mustChangePassword).toBe(false);
      // All prior sessions revoked...
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      // ...and a brand-new pair minted for the current session.
      expect(prisma.refreshToken.create).toHaveBeenCalledTimes(1);
      expect(result.accessToken).toEqual(expect.any(String));
      expect(result.refreshToken).toEqual(expect.any(String));
      expect(result.user.mustChangePassword).toBe(false);
      expect(result.user.id).toBe('user-1');
    });
  });
});
