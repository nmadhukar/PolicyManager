import { randomBytes } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service';
import { AssignRolesDto } from './dto/assign-roles.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

/**
 * Public-facing user shape. NEVER includes passwordHash / mfaSecret (AGENTS.md §8).
 */
export interface UserView {
  id: string;
  email: string;
  name: string;
  title: string | null;
  status: string;
  roles: string[];
  createdAt: Date;
  updatedAt: Date;
}

/** Result of creating a user; temporaryPassword is surfaced exactly once. */
export interface CreatedUser {
  user: UserView;
  temporaryPassword: string;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  private static userSelect() {
    return {
      id: true,
      email: true,
      name: true,
      title: true,
      status: true,
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

  async setStatus(id: string, status: 'active' | 'disabled'): Promise<UserView> {
    await this.ensureExists(id);
    // Revoke live refresh tokens when disabling so access cannot be silently renewed.
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
