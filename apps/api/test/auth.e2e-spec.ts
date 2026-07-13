import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import request from 'supertest';
import { PERMISSIONS, ROLES } from '@policymanager/shared';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * End-to-end proof (against the running Postgres) that:
 *  - login returns access + refresh tokens,
 *  - GET /api/auth/me works with a token and 401 without,
 *  - a `user.manage`-guarded route is 403 for Staff and 200 for Admin,
 *  - refresh rotates and logout revokes.
 */
describe('Auth & RBAC (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const suffix = Date.now();
  const adminEmail = `e2e-admin-${suffix}@policymanager.local`;
  const staffEmail = `e2e-staff-${suffix}@policymanager.local`;
  const password = 'E2e-Pass!123';
  const createdUserIds: string[] = [];

  /** Ensures the required permissions + roles exist, returning role ids. */
  async function ensureRbac() {
    const permKeys = [PERMISSIONS.USER_MANAGE, PERMISSIONS.DOCUMENT_READ];
    const permIds: Record<string, string> = {};
    for (const key of permKeys) {
      const p = await prisma.permission.upsert({ where: { key }, update: {}, create: { key } });
      permIds[key] = p.id;
    }
    const admin = await prisma.role.upsert({
      where: { name: ROLES.ADMIN },
      update: {},
      create: { name: ROLES.ADMIN, isSystem: true },
    });
    const staff = await prisma.role.upsert({
      where: { name: ROLES.STAFF },
      update: {},
      create: { name: ROLES.STAFF, isSystem: true },
    });
    for (const [roleId, keys] of [
      [admin.id, [PERMISSIONS.USER_MANAGE, PERMISSIONS.DOCUMENT_READ]],
      [staff.id, [PERMISSIONS.DOCUMENT_READ]],
    ] as const) {
      for (const k of keys) {
        await prisma.rolePermission.upsert({
          where: { roleId_permissionId: { roleId, permissionId: permIds[k] } },
          update: {},
          create: { roleId, permissionId: permIds[k] },
        });
      }
    }
    return { adminRoleId: admin.id, staffRoleId: staff.id };
  }

  async function makeUser(email: string, roleId: string) {
    const passwordHash = await argon2.hash(password);
    const user = await prisma.user.create({
      data: {
        email,
        name: email,
        passwordHash,
        roles: { create: { roleId } },
      },
    });
    createdUserIds.push(user.id);
    return user;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api', { exclude: ['health'] });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await app.init();

    prisma = app.get(PrismaService);
    const { adminRoleId, staffRoleId } = await ensureRbac();
    await makeUser(adminEmail, adminRoleId);
    await makeUser(staffEmail, staffRoleId);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.refreshToken.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app?.close();
  });

  const login = (email: string) =>
    request(app.getHttpServer()).post('/api/auth/login').send({ email, password });

  it('login returns access + refresh tokens and a user with permissions', async () => {
    const res = await login(adminEmail).expect(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.refreshToken).toEqual(expect.any(String));
    expect(res.body.user.email).toBe(adminEmail);
    expect(res.body.user.permissions).toContain(PERMISSIONS.USER_MANAGE);
    // Never leak the password hash.
    expect(JSON.stringify(res.body)).not.toContain('argon2');
  });

  it('rejects bad credentials with 401', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: adminEmail, password: 'wrong' })
      .expect(401);
  });

  it('GET /api/auth/me returns the user WITH a token and 401 WITHOUT', async () => {
    const { body } = await login(adminEmail).expect(200);
    await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${body.accessToken}`)
      .expect(200)
      .expect((r) => expect(r.body.email).toBe(adminEmail));

    await request(app.getHttpServer()).get('/api/auth/me').expect(401);
  });

  it('user.manage route: 403 for Staff, 200 for Admin', async () => {
    const staff = await login(staffEmail).expect(200);
    await request(app.getHttpServer())
      .get('/api/users')
      .set('Authorization', `Bearer ${staff.body.accessToken}`)
      .expect(403);

    const admin = await login(adminEmail).expect(200);
    await request(app.getHttpServer())
      .get('/api/users')
      .set('Authorization', `Bearer ${admin.body.accessToken}`)
      .expect(200)
      .expect((r) => expect(Array.isArray(r.body)).toBe(true));
  });

  it('refresh rotates the token; the old one cannot be reused', async () => {
    const { body } = await login(adminEmail).expect(200);
    const rotated = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .send({ refreshToken: body.refreshToken })
      .expect(200);
    expect(rotated.body.refreshToken).not.toBe(body.refreshToken);

    // Reusing the original (now revoked) refresh token fails.
    await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .send({ refreshToken: body.refreshToken })
      .expect(401);
  });

  it('logout revokes the refresh token', async () => {
    const { body } = await login(adminEmail).expect(200);
    await request(app.getHttpServer())
      .post('/api/auth/logout')
      .send({ refreshToken: body.refreshToken })
      .expect(204);
    await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .send({ refreshToken: body.refreshToken })
      .expect(401);
  });
});
