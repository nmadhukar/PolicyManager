import { randomBytes } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { AssignRolesDto } from './dto/assign-roles.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

/**
 * Public-facing user shape. NEVER includes passwordHash / mfaSecret (AGENTS.md §8).
 * `lockedUntil` (credential lockout) is intentionally distinct from `status`
 * (enabled/disabled) so the admin UI can present and act on them separately.
 */
export interface UserView {
  id: string;
  email: string;
  name: string;
  title: string | null;
  status: string;
  roles: string[];
  mustChangePassword: boolean;
  lockedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Result of creating a user; temporaryPassword is surfaced exactly once. */
export interface CreatedUser {
  user: UserView;
  temporaryPassword: string;
}

/** Outcome of an admin-initiated password reset. */
export interface AdminResetResult {
  mode: 'temp' | 'email';
  /** Present only for `temp` mode — shown to the admin exactly once. */
  temporaryPassword?: string;
  /** Present only for `email` mode. */
  emailed?: boolean;
}

/**
 * Far-future sentinel used for an EXPLICIT admin lock, distinguishing it from a
 * time-boxed brute-force lock (which sets a near-future `lockedUntil`).
 */
const ADMIN_LOCK_UNTIL = new Date('9999-12-31T23:59:59.000Z');

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}

  private static userSelect() {
    return {
      id: true,
      email: true,
      name: true,
      title: true,
      status: true,
      mustChangePassword: true,
      lockedUntil: true,
      createdAt: true,
      updatedAt: true,
      roles: { include: { role: true } },
    } as const;
  }

  private toView(user: {
    id: string;
    email: string;
    name: string;
    title: string | null;
    status: string;
    mustChangePassword: boolean;
    lockedUntil: Date | null;
    createdAt: Date;
    updatedAt: Date;
    roles: { role: { name: string } }[];
  }): UserView {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      title: user.title,
      status: user.status,
      mustChangePassword: user.mustChangePassword,
      lockedUntil: user.lockedUntil,
      roles: user.roles.map((r) => r.role.name),
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  /** Resolves role names to ids; throws 400 listing any that do not exist. */
  private async resolveRoleIds(names: string[]): Promise<{ id: string }[]> {
    if (names.length === 0) return [];
    const roles = await this.prisma.role.findMany({ where: { name: { in: names } } });
    const found = new Set(roles.map((r) => r.name));
    const missing = names.filter((n) => !found.has(n));
    if (missing.length > 0) {
      throw new BadRequestException(`Unknown role(s): ${missing.join(', ')}`);
    }
    return roles.map((r) => ({ id: r.id }));
  }

  async list(): Promise<UserView[]> {
    const users = await this.prisma.user.findMany({
      select: UsersService.userSelect(),
      orderBy: { createdAt: 'asc' },
    });
    return users.map((u) => this.toView(u));
  }

  async get(id: string): Promise<UserView> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: UsersService.userSelect(),
    });
    if (!user) throw new NotFoundException('User not found');
    return this.toView(user);
  }

  async create(dto: CreateUserDto): Promise<CreatedUser> {
    const email = dto.email.toLowerCase().trim();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) throw new ConflictException('A user with that email already exists');

    const roleIds = await this.resolveRoleIds(dto.roles ?? []);
    const temporaryPassword = dto.password ?? UsersService.generateTempPassword();
    const passwordHash = await argon2.hash(temporaryPassword);

    const user = await this.prisma.user.create({
      data: {
        email,
        name: dto.name,
        title: dto.title,
        passwordHash,
        // New accounts start with a temp password they must change on first login.
        mustChangePassword: true,
        identities: { create: { provider: 'local', subject: email, email } },
        roles: { create: roleIds.map((r) => ({ roleId: r.id })) },
      },
      select: UsersService.userSelect(),
    });

    return { user: this.toView(user), temporaryPassword };
  }

  async update(id: string, dto: UpdateUserDto): Promise<UserView> {
    await this.ensureExists(id);
    const user = await this.prisma.user.update({
      where: { id },
      data: { name: dto.name, title: dto.title, status: dto.status },
      select: UsersService.userSelect(),
    });
    return this.toView(user);
  }

  /**
   * Enables/disables an account (distinct from lock). Guards against an admin
   * disabling their own account (self-lockout). Disabling revokes live refresh
   * tokens so access cannot be silently renewed.
   */
  async setStatus(
    id: string,
    status: 'active' | 'disabled',
    actingUserId?: string,
  ): Promise<UserView> {
    await this.ensureExists(id);
    if (status === 'disabled' && actingUserId && actingUserId === id) {
      throw new BadRequestException('You cannot disable your own account.');
    }
    if (status === 'disabled') {
      await this.prisma.refreshToken.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    const user = await this.prisma.user.update({
      where: { id },
      data: { status },
      select: UsersService.userSelect(),
    });
    return this.toView(user);
  }

  /**
   * Admin-initiated credential lockout (distinct from disable). Sets a far-future
   * `lockedUntil` and revokes live refresh tokens. An admin cannot lock themselves.
   */
  async lockUser(id: string, actingUserId: string): Promise<UserView> {
    await this.ensureExists(id);
    if (actingUserId === id) {
      throw new BadRequestException('You cannot lock your own account.');
    }
    await this.prisma.refreshToken.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    const user = await this.prisma.user.update({
      where: { id },
      data: { lockedUntil: ADMIN_LOCK_UNTIL },
      select: UsersService.userSelect(),
    });
    return this.toView(user);
  }

  /** Clears any lock (explicit or brute-force) and resets the failure counter. */
  async unlockUser(id: string): Promise<UserView> {
    await this.ensureExists(id);
    const user = await this.prisma.user.update({
      where: { id },
      data: { lockedUntil: null, failedLoginAttempts: 0 },
      select: UsersService.userSelect(),
    });
    return this.toView(user);
  }

  /**
   * Admin password reset. Two modes:
   *  - `temp`: set a fresh temporary password (returned to the admin ONCE) and
   *    force a change on next login;
   *  - `email`: send the user a self-service reset link (no password disclosed).
   * Both revoke live refresh tokens for the target user.
   */
  async adminResetPassword(id: string, mode: 'temp' | 'email'): Promise<AdminResetResult> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, name: true },
    });
    if (!user) throw new NotFoundException('User not found');

    if (mode === 'email') {
      await this.auth.issuePasswordReset(user);
      await this.revokeRefreshTokens(id);
      return { mode: 'email', emailed: true };
    }

    // temp mode
    const temporaryPassword = UsersService.generateTempPassword();
    const passwordHash = await argon2.hash(temporaryPassword);
    await this.prisma.user.update({
      where: { id },
      data: { passwordHash, mustChangePassword: true, failedLoginAttempts: 0, lockedUntil: null },
    });
    await this.revokeRefreshTokens(id);
    return { mode: 'temp', temporaryPassword };
  }

  /** Replaces the user's full role set with the provided names. */
  async assignRoles(id: string, dto: AssignRolesDto): Promise<UserView> {
    await this.ensureExists(id);
    const roleIds = await this.resolveRoleIds(dto.roles);
    await this.prisma.$transaction([
      this.prisma.userRole.deleteMany({ where: { userId: id } }),
      this.prisma.userRole.createMany({
        data: roleIds.map((r) => ({ userId: id, roleId: r.id })),
        skipDuplicates: true,
      }),
    ]);
    return this.get(id);
  }

  private async revokeRefreshTokens(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async ensureExists(id: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!user) throw new NotFoundException('User not found');
  }

  /** Generates a reasonably strong, human-shareable temporary password. */
  static generateTempPassword(): string {
    // 18 base64url chars (~108 bits) + guaranteed symbol/case to satisfy policies.
    return `Pm-${randomBytes(12).toString('base64url')}!`;
  }
}
