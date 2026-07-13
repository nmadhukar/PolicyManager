import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import request from 'supertest';
import { PERMISSIONS, ROLES } from '@policymanager/shared';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * End-to-end proof (live Postgres + MailHog) of the user-management + mailer slice:
 *  - forgot-password never enumerates (200 for an unknown email, no token created),
 *  - a real emailed token drives a full reset that changes the password AND
 *    revokes previously-issued refresh tokens,
 *  - 5 bad logins lock an account and a correct password is still rejected while
 *    locked (with an account-locked email captured),
 *  - admin temp/email reset + lock/unlock work, self-lock is blocked, and a
 *    non-admin is 403 on every admin action.
 *
 * Requires MailHog on :8025 (SMTP :1025) — the dev docker-compose stack.
 */
const MAILHOG = 'http://localhost:8025';

interface MailHogItem {
  Content: { Headers: { To: string[]; Subject: string[] } };
  MIME?: { Parts?: { Body: string }[] };
}

/** Decodes quoted-printable so the emailed reset URL can be parsed intact. */
function qpDecode(s: string): string {
  return s
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

async function mailhogMessages(): Promise<MailHogItem[]> {
  const res = await fetch(`${MAILHOG}/api/v2/messages?limit=200`);
  const data = (await res.json()) as { items: MailHogItem[] };
  return data.items ?? [];
}

/** Polls MailHog for a message to `to` whose subject matches `subjectRe`. */
async function waitForEmail(
  to: string,
  subjectRe: RegExp,
  timeoutMs = 6000,
): Promise<MailHogItem> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const items = await mailhogMessages();
    const match = items.find(
      (m) =>
        m.Content.Headers.To?.some((t) => t.includes(to)) &&
        m.Content.Headers.Subject?.some((s) => subjectRe.test(s)),
    );
    if (match) return match;
    if (Date.now() > deadline) {
      throw new Error(`No email to ${to} matching ${subjectRe} within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Concatenated, QP-decoded body of a MailHog message across all MIME parts. */
function bodyOf(msg: MailHogItem): string {
  const parts = msg.MIME?.Parts?.map((p) => p.Body) ?? [];
  return qpDecode(parts.join('\n'));
}

describe('User management & mailer (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const suffix = Date.now();
  const adminEmail = `e2e-um-admin-${suffix}@policymanager.local`;
  const staffEmail = `e2e-um-staff-${suffix}@policymanager.local`;
  const resetEmail = `e2e-um-reset-${suffix}@policymanager.local`;
  const lockEmail = `e2e-um-lock-${suffix}@policymanager.local`;
  const targetEmail = `e2e-um-target-${suffix}@policymanager.local`;
  const password = 'E2e-Pass!123';
  const createdUserIds: string[] = [];
  let targetId = '';
  let staffRoleIdRef = '';

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

  async function makeUser(email: string, roleId: string): Promise<string> {
    const passwordHash = await argon2.hash(password);
    const user = await prisma.user.create({
      data: { email, name: email, passwordHash, roles: { create: { roleId } } },
    });
    createdUserIds.push(user.id);
    return user.id;
  }

  const login = (email: string, pw: string) =>
    request(app.getHttpServer()).post('/api/auth/login').send({ email, password: pw });

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
    staffRoleIdRef = staffRoleId;
    await makeUser(adminEmail, adminRoleId);
    await makeUser(staffEmail, staffRoleId);
    await makeUser(resetEmail, staffRoleId);
    await makeUser(lockEmail, staffRoleId);
    targetId = await makeUser(targetEmail, staffRoleId);

    // Start from a clean mailbox so recipient/subject matches are unambiguous.
    await fetch(`${MAILHOG}/api/v1/messages`, { method: 'DELETE' });
  }, 40000);

  afterAll(async () => {
    if (prisma) {
      await prisma.passwordResetToken.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.refreshToken.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app?.close();
  });

  it('forgot-password returns 200 for an UNKNOWN email and creates no token (no enumeration)', async () => {
    const unknown = `e2e-um-ghost-${suffix}@nope.local`;
    const res = await request(app.getHttpServer())
      .post('/api/auth/forgot-password')
      .send({ email: unknown })
      .expect(200);
    // Neutral message, identical to the real-account path.
    expect(res.body.message).toMatch(/if an account exists/i);

    const ghost = await prisma.user.findUnique({ where: { email: unknown } });
    expect(ghost).toBeNull();
  });

  it('runs the FULL reset flow from a real emailed token and revokes old sessions', async () => {
    // Establish a session whose refresh token must be revoked by the reset.
    const pre = await login(resetEmail, password).expect(200);
    const oldRefresh = pre.body.refreshToken as string;

    // Request the reset; the handler emails the link before responding 200.
    await request(app.getHttpServer())
      .post('/api/auth/forgot-password')
      .send({ email: resetEmail })
      .expect(200);

    // A reset email was captured for this user...
    const email = await waitForEmail(resetEmail, /reset/i);
    const token = /reset-password\?token=([A-Za-z0-9_-]+)/.exec(bodyOf(email))?.[1];
    expect(token).toBeTruthy();

    // ...and a matching single-use token row exists.
    const tokenRow = await prisma.passwordResetToken.findFirst({
      where: { userId: pre.body.user.id, usedAt: null },
    });
    expect(tokenRow).not.toBeNull();

    const newPassword = 'E2e-New!456';
    await request(app.getHttpServer())
      .post('/api/auth/reset-password')
      .send({ token, newPassword })
      .expect(200);

    // Old refresh token is revoked; old password no longer works; new one does.
    await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .send({ refreshToken: oldRefresh })
      .expect(401);
    await login(resetEmail, password).expect(401);
    await login(resetEmail, newPassword).expect(200);

    // The reset token is now single-use (consumed).
    await request(app.getHttpServer())
      .post('/api/auth/reset-password')
      .send({ token, newPassword: 'E2e-Other!789' })
      .expect(400);
  }, 30000);

  it('locks an account after 5 bad logins; a correct password is still rejected while locked', async () => {
    for (let i = 0; i < 5; i++) {
      await login(lockEmail, 'wrong-password').expect(401);
    }
    // Even the CORRECT password is rejected while locked.
    await login(lockEmail, password).expect(401);

    // An account-locked email was captured.
    await waitForEmail(lockEmail, /lock/i);

    // The lock is persisted with a future expiry.
    const locked = await prisma.user.findUnique({ where: { email: lockEmail } });
    expect(locked?.lockedUntil).toBeTruthy();
    expect(locked!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(locked?.failedLoginAttempts).toBeGreaterThanOrEqual(5);
  }, 30000);

  it('admin temp-reset forces a change and the temp password works once', async () => {
    const admin = await login(adminEmail, password).expect(200);
    const adminToken = admin.body.accessToken;
    // targetId set in beforeAll.

    const res = await request(app.getHttpServer())
      .post(`/api/users/${targetId}/reset-password`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ mode: 'temp' })
      .expect(201);
    expect(res.body.mode).toBe('temp');
    expect(typeof res.body.temporaryPassword).toBe('string');

    // The temp password logs in and the response flags a required change.
    const loggedIn = await login(targetEmail, res.body.temporaryPassword).expect(200);
    expect(loggedIn.body.user.mustChangePassword).toBe(true);
  }, 30000);

  it('admin email-reset sends a link, and lock/unlock gate sign-in', async () => {
    const admin = await login(adminEmail, password).expect(200);
    const adminToken = admin.body.accessToken;
    // targetId set in beforeAll.

    // email mode
    const emailRes = await request(app.getHttpServer())
      .post(`/api/users/${targetId}/reset-password`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ mode: 'email' })
      .expect(201);
    expect(emailRes.body).toEqual({ mode: 'email', emailed: true });
    await waitForEmail(targetEmail, /reset/i);

    // Give the target a known password to prove lock/unlock gate it.
    const tempRes = await request(app.getHttpServer())
      .post(`/api/users/${targetId}/reset-password`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ mode: 'temp' })
      .expect(201);
    const tempPw = tempRes.body.temporaryPassword as string;
    await login(targetEmail, tempPw).expect(200);

    // Lock -> even the correct password is rejected.
    await request(app.getHttpServer())
      .post(`/api/users/${targetId}/lock`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);
    await login(targetEmail, tempPw).expect(401);

    // Unlock -> sign-in works again.
    await request(app.getHttpServer())
      .post(`/api/users/${targetId}/unlock`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);
    await login(targetEmail, tempPw).expect(200);
  }, 30000);

  it('blocks an admin from locking their OWN account (400)', async () => {
    const admin = await login(adminEmail, password).expect(200);
    await request(app.getHttpServer())
      .post(`/api/users/${admin.body.user.id}/lock`)
      .set('Authorization', `Bearer ${admin.body.accessToken}`)
      .expect(400);
  });

  it('is 403 for a non-admin on every admin user action', async () => {
    const staff = await login(staffEmail, password).expect(200);
    const staffToken = staff.body.accessToken;
    // targetId set in beforeAll.

    await request(app.getHttpServer())
      .post(`/api/users/${targetId}/reset-password`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ mode: 'temp' })
      .expect(403);
    await request(app.getHttpServer())
      .post(`/api/users/${targetId}/lock`)
      .set('Authorization', `Bearer ${staffToken}`)
      .expect(403);
    await request(app.getHttpServer())
      .post(`/api/users/${targetId}/unlock`)
      .set('Authorization', `Bearer ${staffToken}`)
      .expect(403);
  });

  it('authenticated change-password rotates the session and rejects a wrong current password', async () => {
    // Fresh account with a known password.
    const changeEmail = `e2e-um-change-${suffix}@policymanager.local`;
    await makeUser(changeEmail, staffRoleIdRef);

    const session = await login(changeEmail, password).expect(200);
    const token = session.body.accessToken;
    const oldRefresh = session.body.refreshToken as string;

    // Wrong current password -> 400 (not 401).
    await request(app.getHttpServer())
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'nope', newPassword: 'E2e-Change!1' })
      .expect(400);

    // Correct change -> 200 with a FRESH token pair; old refresh is revoked.
    const changed = await request(app.getHttpServer())
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: password, newPassword: 'E2e-Change!1' })
      .expect(200);
    expect(changed.body.refreshToken).toEqual(expect.any(String));
    expect(changed.body.refreshToken).not.toBe(oldRefresh);

    await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .send({ refreshToken: oldRefresh })
      .expect(401);
    await login(changeEmail, 'E2e-Change!1').expect(200);
  }, 30000);
});
