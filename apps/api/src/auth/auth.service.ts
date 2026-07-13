import { createHash, randomBytes } from 'crypto';
import {
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import type { AuthUser } from '@policymanager/shared';
import { PrismaService } from '../prisma/prisma.service';
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Deterministic hash used to look up a persisted refresh token by its raw
   * value. SHA-256 is appropriate here because the token is high-entropy
   * (128-bit random) — unlike passwords, it is not brute-forceable, and a
   * deterministic digest is required for an indexed lookup.
   */
  static hashRefreshToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  /** Verifies email + password against a local (password-backed) account. */
  async validateCredentials(email: string, password: string): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
      include: this.userInclude(),
    });

    // Uniform failure to avoid leaking which part was wrong / account existence.
    if (!user || !user.passwordHash || user.status !== 'active') {
      throw new UnauthorizedException('Invalid credentials');
    }
    const ok = await argon2.verify(user.passwordHash, password);
    if (!ok) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return this.toAuthUser(user);
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
   * Rotates a refresh token: validates the presented raw token, revokes it, and
   * issues a brand-new pair. Reuse of an already-revoked/expired/unknown token
   * is rejected with 401.
   */
  async refresh(rawRefresh: string): Promise<AuthResult> {
    const tokenHash = AuthService.hashRefreshToken(rawRefresh);
    const record = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });

    if (!record || record.revokedAt || record.expiresAt.getTime() <= Date.now()) {
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
    return { id: user.id, email: user.email, name: user.name, roles, permissions };
  }
}
