import { createHash, randomBytes } from 'crypto';
import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { ROLES, type AuthUser } from '@policymanager/shared';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import type { AzureOidcProfile } from './azure-oidc.service';
import { assertPasswordPolicy } from './password-policy';
import type { AuthResult, AuthTokens, JwtPayload } from './auth.types';

/**
 * Duration parser: converts strings like "900s", "15m", "7d", "24h" or a bare
 * number of seconds into milliseconds. Used to compute refresh-token expiry.
 */
export function ttlToMs(ttl: string): number {
  const match = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(ttl.trim());
  if (!match) {
    throw new Error(`Invalid TTL value: ${ttl}`);
  }
  const value = Number(match[1]);
  const unit = match[2] ?? 's';
  const factor: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return value * factor[unit];
}

@Injectable()
export class AuthService {
  /**
   * Uniform failure message for EVERY login rejection (unknown user, wrong
   * password, disabled, or locked). A distinct "locked" message would leak
   * account existence/state, so all paths return this identical string.
   */
  static readonly INVALID_LOGIN = 'Invalid credentials or locked';

  /** Failed logins before an account is auto-locked. */
  static readonly MAX_FAILED_ATTEMPTS = 5;
  /** How long a brute-force lock lasts. */
  static readonly LOCK_DURATION_MS = 15 * 60_000;
  /** Password-reset link validity window. */
  static readonly RESET_TOKEN_TTL_MS = 30 * 60_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
  ) {}

  /**
   * Deterministic hash used to look up a persisted refresh/reset token by its raw
   * value. SHA-256 is appropriate here because the token is high-entropy
   * (>=256-bit random) — unlike passwords, it is not brute-forceable, and a
   * deterministic digest is required for an indexed lookup.
   */
  static hashRefreshToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  /**
   * Verifies email + password against a local (password-backed) account, applying
   * brute-force lockout. Every failure returns the same uniform 401 to avoid
   * account enumeration.
   */
  async validateCredentials(email: string, password: string): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
      include: this.userInclude(),
    });

    const now = Date.now();
    // Currently locked (brute-force auto-lock OR explicit admin lock) -> reject
    // WITHOUT verifying the password, so a locked account cannot be probed.
    if (user?.lockedUntil && user.lockedUntil.getTime() > now) {
      throw new UnauthorizedException(AuthService.INVALID_LOGIN);
    }
    if (!user || !user.passwordHash || user.status !== 'active') {
      throw new UnauthorizedException(AuthService.INVALID_LOGIN);
    }

    const ok = await argon2.verify(user.passwordHash, password);
    if (!ok) {
      await this.registerFailedAttempt(user);
      throw new UnauthorizedException(AuthService.INVALID_LOGIN);
    }

    // Success: clear any accumulated failure/lock state.
    if ((user.failedLoginAttempts ?? 0) > 0 || user.lockedUntil) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: 0, lockedUntil: null },
      });
    }
    return this.toAuthUser(user);
  }

  /**
   * Records a failed login. Increments the counter and, at the threshold, sets a
   * time-boxed lock and emails a security notice (best-effort). If a previous
   * lock has already expired, the window restarts fresh from this attempt.
   */
  private async registerFailedAttempt(user: {
    id: string;
    email: string;
    name: string;
    failedLoginAttempts: number | null;
    lockedUntil: Date | null;
  }): Promise<void> {
    const now = Date.now();
    const lockExpired = !!(user.lockedUntil && user.lockedUntil.getTime() <= now);
    const previous = lockExpired ? 0 : user.failedLoginAttempts ?? 0;
    const attempts = previous + 1;
    const willLock = attempts >= AuthService.MAX_FAILED_ATTEMPTS;

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: attempts,
        lockedUntil: willLock
          ? new Date(now + AuthService.LOCK_DURATION_MS)
          : lockExpired
            ? null
            : user.lockedUntil ?? null,
      },
    });

    if (willLock) {
      // Best-effort — a mail outage must never block the (already failing) login.
      await this.mail.sendAccountLocked(user.email, user.name);
    }
  }

  /** Issues a fresh access+refresh pair and persists the refresh-token hash. */
  async issueTokens(user: AuthUser): Promise<AuthTokens> {
    const payload: JwtPayload = { sub: user.id, email: user.email };
    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      expiresIn: this.config.get<string>('JWT_ACCESS_TTL', '900s'),
    });

    const rawRefresh = randomBytes(48).toString('base64url');
    const refreshTtl = this.config.get<string>('JWT_REFRESH_TTL', '7d');
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: AuthService.hashRefreshToken(rawRefresh),
        expiresAt: new Date(Date.now() + ttlToMs(refreshTtl)),
      },
    });

    return { accessToken, refreshToken: rawRefresh };
  }

  /** Full login flow: validate credentials then issue tokens. */
  async login(email: string, password: string): Promise<AuthResult> {
    const user = await this.validateCredentials(email, password);
    const tokens = await this.issueTokens(user);
    return { ...tokens, user };
  }

  /**
   * Completes an OIDC login (ADR 0003): resolves the local `User` for a
   * validated identity-provider profile, then issues tokens exactly as local
   * login does. Resolution order:
   *   1. `UserIdentity` already linked to this `(provider, subject)` — reuse it.
   *   2. An existing `User` with a matching (verified) email — link a new
   *      `UserIdentity` onto it. An unverified email claim never links, since
   *      that would let an attacker hijack an account by claiming its address.
   *   3. Neither — create a brand-new `User` + `UserIdentity`, defaulting to
   *      the Staff role (never Admin) until Azure AD group -> role mapping
   *      exists (deferred per ADR 0003).
   */
  async loginWithOidc(provider: string, profile: AzureOidcProfile): Promise<AuthResult> {
    const existingIdentity = await this.prisma.userIdentity.findUnique({
      where: { provider_subject: { provider, subject: profile.subject } },
      include: { user: { include: this.userInclude() } },
    });

    if (existingIdentity) {
      if (existingIdentity.user.status !== 'active') {
        throw new UnauthorizedException(AuthService.INVALID_LOGIN);
      }
      const user = this.toAuthUser(existingIdentity.user);
      const tokens = await this.issueTokens(user);
      return { ...tokens, user };
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { email: profile.email },
      include: this.userInclude(),
    });

    if (existingUser) {
      if (existingUser.status !== 'active') {
        throw new UnauthorizedException(AuthService.INVALID_LOGIN);
      }
      if (!profile.emailVerified) {
        // Do not silently take over an existing account on an unverified claim.
        throw new UnauthorizedException(AuthService.INVALID_LOGIN);
      }
      await this.prisma.userIdentity.create({
        data: {
          userId: existingUser.id,
          provider,
          subject: profile.subject,
          email: profile.email,
        },
      });
      const user = this.toAuthUser(existingUser);
      const tokens = await this.issueTokens(user);
      return { ...tokens, user };
    }

    const staffRole = await this.prisma.role.findUnique({ where: { name: ROLES.STAFF } });
    if (!staffRole) {
      // Seed data is expected to exist (PM-0202); this is a deployment defect,
      // not a user-facing auth failure — fail loudly rather than provisioning
      // a role-less account.
      throw new BadRequestException('Default role is not configured.');
    }

    // A single nested-write `create` (user + its identity + its role) is
    // already one atomic INSERT — no separate $transaction call is needed.
    const created = await this.prisma.user.create({
      data: {
        email: profile.email,
        name: profile.name,
        status: 'active',
        identities: {
          create: { provider, subject: profile.subject, email: profile.email },
        },
        roles: { create: { roleId: staffRole.id } },
      },
      include: this.userInclude(),
    });

    const user = this.toAuthUser(created);
    const tokens = await this.issueTokens(user);
    return { ...tokens, user };
  }

  /**
   * Rotates a refresh token: validates the presented raw token, revokes it, and
   * issues a brand-new pair. Reuse of an already-revoked/expired/unknown token
   * is rejected with 401.
   */
  async refresh(rawRefresh: string): Promise<AuthResult> {
    const tokenHash = AuthService.hashRefreshToken(rawRefresh);
    const record = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });

    if (!record) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    // SL4 — reuse detection: a KNOWN but already-revoked token was replayed. Because
    // rotation revokes each token as it is spent, presenting a revoked token means
    // either a rotated token was stolen and replayed, or the legitimate holder
    // raced. Either way, treat it as a compromised token family and REVOKE ALL of
    // this user's live refresh tokens (family kill), forcing a fresh login.
    if (record.revokedAt) {
      await this.prisma.refreshToken.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (record.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: record.userId },
      include: this.userInclude(),
    });
    if (!user || user.status !== 'active') {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Rotate: revoke the presented token, then mint a new pair.
    await this.prisma.refreshToken.update({
      where: { id: record.id },
      data: { revokedAt: new Date() },
    });

    const authUser = this.toAuthUser(user);
    const tokens = await this.issueTokens(authUser);
    return { ...tokens, user: authUser };
  }

  /** Revokes a refresh token (logout). Idempotent — unknown tokens are a no-op. */
  async logout(rawRefresh: string): Promise<void> {
    const tokenHash = AuthService.hashRefreshToken(rawRefresh);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Public self-service reset request. ALWAYS resolves (no account enumeration):
   * only a real, active, local (password-backed) account triggers an email.
   */
  async forgotPassword(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
      select: { id: true, email: true, name: true, status: true, passwordHash: true },
    });
    if (user && user.status === 'active' && user.passwordHash) {
      await this.issuePasswordReset(user);
    }
    // Deliberately silent for the non-existent / ineligible case.
  }

  /**
   * Creates a single-use reset token and emails the link. Shared by the public
   * forgot-password flow and the admin "email a reset" action. Only the SHA-256
   * of the raw token is stored; the raw token exists only in the email.
   */
  async issuePasswordReset(user: { id: string; email: string; name: string }): Promise<void> {
    const rawToken = randomBytes(32).toString('base64url');
    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: AuthService.hashRefreshToken(rawToken),
        expiresAt: new Date(Date.now() + AuthService.RESET_TOKEN_TTL_MS),
      },
    });

    const base =
      this.config.get<string>('WEB_APP_URL') ||
      this.config.get<string>('FRONTEND_URL') ||
      'http://localhost:5173';
    const resetUrl = `${base.replace(/\/+$/, '')}/reset-password?token=${rawToken}`;
    await this.mail.sendPasswordReset(user.email, user.name, resetUrl);
  }

  /**
   * Consumes a reset token and sets a new password. Validates the token
   * (exists, unused, unexpired), enforces the policy, then atomically: sets the
   * argon2 hash, marks the token used, clears lockout + must-change, and revokes
   * every existing refresh token (a reset ends all sessions). Returns the id of
   * the user whose password was reset so the caller can audit the event.
   */
  async resetPassword(rawToken: string, newPassword: string): Promise<{ userId: string }> {
    const tokenHash = AuthService.hashRefreshToken(rawToken);
    const record = await this.prisma.passwordResetToken.findUnique({ where: { tokenHash } });

    if (!record || record.usedAt || record.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('This reset link is invalid or has expired.');
    }

    // Enforce BEFORE consuming the token so a weak password lets the user retry.
    assertPasswordPolicy(newPassword);
    const passwordHash = await argon2.hash(newPassword);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: record.userId },
        data: {
          passwordHash,
          mustChangePassword: false,
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      }),
      this.prisma.passwordResetToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    return { userId: record.userId };
  }

  /**
   * Authenticated self-service password change. Verifies the current password,
   * enforces the policy, sets the new hash, clears must-change, and revokes ALL
   * existing refresh tokens (every other session must re-authenticate). A brand
   * new token pair is then minted and returned so the CURRENT session stays alive
   * without the caller re-logging in.
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<AuthResult> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: this.userInclude(),
    });
    if (!user || !user.passwordHash) {
      throw new BadRequestException('Password change is not available for this account.');
    }

    const ok = await argon2.verify(user.passwordHash, currentPassword);
    if (!ok) {
      // 400 (not 401): the caller IS authenticated; this is a bad field value.
      // It also avoids the web client's 401 refresh-and-retry interceptor.
      throw new BadRequestException('Your current password is incorrect.');
    }

    assertPasswordPolicy(newPassword);
    const passwordHash = await argon2.hash(newPassword);

    // Revoke every existing session first...
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash, mustChangePassword: false },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    // ...then issue a fresh pair so the caller keeps a working session.
    const freshUser = this.toAuthUser({ ...user, mustChangePassword: false });
    const tokens = await this.issueTokens(freshUser);
    return { ...tokens, user: freshUser };
  }

  /** Resolves the current AuthUser (roles + permissions) from a user id. */
  async getAuthUser(userId: string): Promise<AuthUser | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: this.userInclude(),
    });
    if (!user || user.status !== 'active') {
      return null;
    }
    return this.toAuthUser(user);
  }

  /** Prisma include tree that pulls roles and their permissions. */
  private userInclude() {
    return {
      roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
    } as const;
  }

  /** Flattens a user+roles+permissions record into the shared AuthUser shape. */
  private toAuthUser(user: {
    id: string;
    email: string;
    name: string;
    mustChangePassword?: boolean;
    roles: {
      role: { name: string; permissions: { permission: { key: string } }[] };
    }[];
  }): AuthUser {
    const roles = user.roles.map((ur) => ur.role.name);
    const permissions = Array.from(
      new Set(
        user.roles.flatMap((ur) => ur.role.permissions.map((rp) => rp.permission.key)),
      ),
    );
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      roles,
      permissions,
      mustChangePassword: user.mustChangePassword ?? false,
    };
  }
}
