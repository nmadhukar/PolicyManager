import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import request from 'supertest';
import { PERMISSIONS, ROLES } from '@policymanager/shared';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { decryptSecret, isEncryptedPayload } from '../src/common/crypto.util';

/**
 * End-to-end proof (live Postgres + MailHog) of Phase 5 — QC review scheduling +
 * SMTP admin:
 *
 *  - an Admin saves the SMTP config (password AES-encrypted at rest; GET never
 *    returns it) and a test email is delivered (captured by MailHog) + logged;
 *  - a quarterly document past its next-review date, with an assigned reviewer, gets
 *    a ReviewTask from run-sweep and the reviewer is emailed (captured) + logged;
 *  - the reviewer completes the task, advancing the document's nextReviewDate ~3
 *    months and writing a review.completed audit row;
 *  - the compliance summary is internally consistent;
 *  - a user lacking smtp.manage/review.manage is forbidden (403), unauthenticated is
 *    401, and the new tables live in `policytracker` (never `public`).
 */
const MAILHOG_API = 'http://localhost:8025/api/v2';

interface MailhogMessage {
  To?: { Mailbox: string; Domain: string }[];
  Content?: { Headers?: { Subject?: string[]; From?: string[] } };
}

async function mailhogMessages(): Promise<MailhogMessage[]> {
  const res = await fetch(`${MAILHOG_API}/messages`);
  const body = (await res.json()) as { items?: MailhogMessage[] };
  return body.items ?? [];
}

const recipients = (m: MailhogMessage): string[] =>
  (m.To ?? []).map((t) => `${t.Mailbox}@${t.Domain}`.toLowerCase());
const subjectOf = (m: MailhogMessage): string => m.Content?.Headers?.Subject?.[0] ?? '';

/** Polls MailHog for a message matching `predicate` (emails are async). */
async function findMail(
  predicate: (m: MailhogMessage) => boolean,
  attempts = 15,
): Promise<MailhogMessage | null> {
  for (let i = 0; i < attempts; i++) {
    const found = (await mailhogMessages()).find(predicate);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

describe('Review scheduling & SMTP admin (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const suffix = Date.now();
  const adminEmail = `e2e-rs-admin-${suffix}@policymanager.local`;
  const staffEmail = `e2e-rs-staff-${suffix}@policymanager.local`;
  const fromAddress = `reviews-${suffix}@policymanager.local`;
  const smtpSecret = `e2e-smtp-secret-${suffix}`;
  const password = 'E2e-Pass!123';

  const createdUserIds: string[] = [];
  const createdDocIds: string[] = [];
  let adminToken = '';
  let staffToken = '';
  let staffId = '';
  let docId = '';
  let taskId = '';

  async function ensureRbac(): Promise<{ adminRoleId: string; staffRoleId: string }> {
    const permKeys = [
      PERMISSIONS.DOCUMENT_READ,
      PERMISSIONS.DOCUMENT_WRITE,
      PERMISSIONS.REVIEW_MANAGE,
      PERMISSIONS.SMTP_MANAGE,
      PERMISSIONS.AUDIT_READ,
    ];
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
    for (const key of permKeys) {
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: admin.id, permissionId: permIds[key] } },
        update: {},
        create: { roleId: admin.id, permissionId: permIds[key] },
      });
    }
    const staff = await prisma.role.upsert({
      where: { name: ROLES.STAFF },
      update: {},
      create: { name: ROLES.STAFF, isSystem: true },
    });
    // Staff gets ONLY document.read (no review.manage, no smtp.manage).
    await prisma.rolePermission.deleteMany({
      where: { roleId: staff.id, permissionId: { not: permIds[PERMISSIONS.DOCUMENT_READ] } },
    });
    await prisma.rolePermission.upsert({
      where: {
        roleId_permissionId: { roleId: staff.id, permissionId: permIds[PERMISSIONS.DOCUMENT_READ] },
      },
      update: {},
      create: { roleId: staff.id, permissionId: permIds[PERMISSIONS.DOCUMENT_READ] },
    });
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

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password })
      .expect(200);
    return res.body.accessToken as string;
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
    staffId = await makeUser(staffEmail, staffRoleId);

    adminToken = await login(adminEmail);
    staffToken = await login(staffEmail);
  }, 45000);

  afterAll(async () => {
    if (prisma) {
      // Immutable evidence now blocks a document DELETE (onDelete: Restrict, D1),
      // so clear attestations + acknowledgments before the documents below.
      await prisma.attestation.deleteMany({ where: { documentId: { in: createdDocIds } } });
      await prisma.acknowledgmentAssignment.deleteMany({ where: { documentId: { in: createdDocIds } } });
      await prisma.reviewTask.deleteMany({ where: { documentId: { in: createdDocIds } } });
      await prisma.reviewAssignment.deleteMany({ where: { documentId: { in: createdDocIds } } });
      await prisma.notificationLog.deleteMany({ where: { toEmail: { contains: String(suffix) } } });
      await prisma.auditEvent.deleteMany({
        where: {
          OR: [{ documentId: { in: createdDocIds } }, { actorUserId: { in: createdUserIds } }],
        },
      });
      await prisma.document.updateMany({
        where: { id: { in: createdDocIds } },
        data: { currentVersionId: null },
      });
      await prisma.documentVersion.deleteMany({ where: { documentId: { in: createdDocIds } } });
      await prisma.document.deleteMany({ where: { id: { in: createdDocIds } } });
      await prisma.refreshToken.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.userRole.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
      // Revert the SMTP singleton so the env fallback resumes for other runs.
      await prisma.smtpConfig.deleteMany({});
    }
    await app?.close();
  });

  const asAdmin = () => `Bearer ${adminToken}`;
  const asStaff = () => `Bearer ${staffToken}`;

  it('Admin saves SMTP config; the password is encrypted at rest and never returned', async () => {
    await request(app.getHttpServer())
      .put('/api/smtp/config')
      .set('Authorization', asAdmin())
      .send({
        host: 'localhost',
        port: 1025,
        secure: false,
        // username omitted => no AUTH attempted against MailHog
        password: smtpSecret,
        fromAddress,
        fromName: 'PolicyManager QC',
        enabled: true,
      })
      .expect(200);

    const view = await request(app.getHttpServer())
      .get('/api/smtp/config')
      .set('Authorization', asAdmin())
      .expect(200);
    expect(view.body.hasPassword).toBe(true);
    expect(view.body.enabled).toBe(true);
    expect(view.body.source).toBe('db');
    // The password is NEVER returned in any form.
    expect(view.body.password).toBeUndefined();
    expect(view.body.passwordEncrypted).toBeUndefined();
    expect(JSON.stringify(view.body)).not.toContain(smtpSecret);

    // At rest it is AES-256-GCM ciphertext, decryptable only with the app key.
    const row = await prisma.smtpConfig.findFirst({ where: { id: 'default' } });
    expect(row?.passwordEncrypted).toBeTruthy();
    expect(row!.passwordEncrypted).not.toContain(smtpSecret);
    expect(isEncryptedPayload(row!.passwordEncrypted)).toBe(true);
    const key = process.env.APP_ENCRYPTION_KEY ?? 'change-me-app-encryption-key';
    expect(decryptSecret(row!.passwordEncrypted as string, key)).toBe(smtpSecret);
  });

  it('A test email is delivered (MailHog) and recorded in the notification log', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/smtp/test')
      .set('Authorization', asAdmin())
      .send({ to: adminEmail })
      .expect(201);
    expect(res.body.ok).toBe(true);

    const mail = await findMail(
      (m) => recipients(m).includes(adminEmail.toLowerCase()) && /smtp test/i.test(subjectOf(m)),
    );
    expect(mail).not.toBeNull();

    const log = await prisma.notificationLog.findFirst({
      where: { toEmail: adminEmail, type: 'smtp_test' },
      orderBy: { createdAt: 'desc' },
    });
    expect(log?.status).toBe('sent');
  }, 20000);

  it('Admin creates a past-due quarterly document and assigns a reviewer', async () => {
    const pastDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const created = await request(app.getHttpServer())
      .post('/api/documents')
      .set('Authorization', asAdmin())
      .send({
        title: `QC Policy ${suffix}`,
        reviewCadence: 'quarterly',
        nextReviewDate: pastDate,
      })
      .expect(201);
    docId = created.body.id;
    createdDocIds.push(docId);
    expect(created.body.reviewCadence).toBe('quarterly');

    const assigned = await request(app.getHttpServer())
      .post(`/api/documents/${docId}/reviewers`)
      .set('Authorization', asAdmin())
      .send({ reviewerId: staffId })
      .expect(201);
    expect(assigned.body.userId).toBe(staffId);

    // review.assigned audited.
    expect(
      await prisma.auditEvent.count({ where: { documentId: docId, action: 'review.assigned' } }),
    ).toBe(1);
  });

  it('run-sweep creates a ReviewTask for the reviewer and emails them (captured + logged)', async () => {
    const sweep = await request(app.getHttpServer())
      .post('/api/reviews/run-sweep')
      .set('Authorization', asAdmin())
      .expect(200);
    expect(sweep.body.tasksCreated).toBeGreaterThanOrEqual(1);

    // The task exists for this document, assigned to the reviewer.
    const list = await request(app.getHttpServer())
      .get('/api/reviews')
      .query({ documentId: docId })
      .set('Authorization', asAdmin())
      .expect(200);
    const task = (list.body.items as { id: string; assignedToId: string }[]).find(
      (t) => t.assignedToId === staffId,
    );
    expect(task).toBeDefined();
    taskId = task!.id;

    // task-created audited (system source).
    expect(
      await prisma.auditEvent.count({
        where: { documentId: docId, action: 'review.task_created' },
      }),
    ).toBeGreaterThanOrEqual(1);

    // Reviewer was emailed (past-due => "Overdue review") + logged against the task.
    const mail = await findMail(
      (m) => recipients(m).includes(staffEmail.toLowerCase()) && /review/i.test(subjectOf(m)),
    );
    expect(mail).not.toBeNull();
    const log = await prisma.notificationLog.findFirst({ where: { reviewTaskId: taskId } });
    expect(log?.status).toBe('sent');
  }, 30000);

  it('Idempotent: a second sweep does not create a duplicate open task for the document', async () => {
    await request(app.getHttpServer())
      .post('/api/reviews/run-sweep')
      .set('Authorization', asAdmin())
      .expect(200);
    const openTasks = await prisma.reviewTask.count({
      where: { documentId: docId, status: { in: ['pending', 'in_progress', 'overdue'] } },
    });
    expect(openTasks).toBe(1);
  }, 30000);

  it('The reviewer completes their task, advancing nextReviewDate ~3 months (audited)', async () => {
    await request(app.getHttpServer())
      .post(`/api/reviews/${taskId}/complete`)
      .set('Authorization', asStaff())
      .send({ notes: 'Reviewed for e2e' })
      .expect(200);

    // review.completed audited.
    expect(
      await prisma.auditEvent.count({ where: { documentId: docId, action: 'review.completed' } }),
    ).toBe(1);

    // Document nextReviewDate advanced to ~3 months from now (80–100 days ahead).
    const doc = await request(app.getHttpServer())
      .get(`/api/documents/${docId}`)
      .set('Authorization', asAdmin())
      .expect(200);
    const next = new Date(doc.body.nextReviewDate).getTime();
    const days = (next - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(80);
    expect(days).toBeLessThan(100);
  });

  it('compliance-summary returns internally-consistent counts', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/reviews/compliance-summary')
      .set('Authorization', asAdmin())
      .expect(200);
    const s = res.body as {
      totalDocuments: number;
      current: number;
      dueSoon: number;
      overdue: number;
      percentCurrent: number;
    };
    expect(s.totalDocuments).toBeGreaterThanOrEqual(1);
    expect(s.current + s.dueSoon + s.overdue).toBeLessThanOrEqual(s.totalDocuments);
    expect(s.percentCurrent).toBe(Math.round((s.current / s.totalDocuments) * 100));
    // The doc we just completed is now current (future-dated), not overdue.
    expect(s.current).toBeGreaterThanOrEqual(1);
  });

  it('enforces RBAC: 403 for a user lacking smtp.manage/review.manage, 401 unauthenticated', async () => {
    // Staff (document.read only) cannot read SMTP config or manage reviewers.
    await request(app.getHttpServer())
      .get('/api/smtp/config')
      .set('Authorization', asStaff())
      .expect(403);
    await request(app.getHttpServer())
      .get(`/api/documents/${docId}/reviewers`)
      .set('Authorization', asStaff())
      .expect(403);
    await request(app.getHttpServer())
      .post(`/api/documents/${docId}/reviewers`)
      .set('Authorization', asStaff())
      .send({ reviewerId: staffId })
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/reviews/compliance-summary')
      .set('Authorization', asStaff())
      .expect(403);

    // Unauthenticated is 401.
    await request(app.getHttpServer()).get('/api/smtp/config').expect(401);
    await request(app.getHttpServer()).get('/api/reviews').expect(401);
  });

  it('a non-manager reviewer sees only their OWN tasks via GET /reviews', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/reviews')
      .set('Authorization', asStaff())
      .expect(200);
    // Every returned task is assigned to the caller (server-side scoping).
    expect(
      (res.body.items as { assignedToId: string }[]).every((t) => t.assignedToId === staffId),
    ).toBe(true);
  });

  it('Schema proof: new tables live in policytracker, never public', async () => {
    const rows = await prisma.$queryRawUnsafe<{ table_schema: string; table_name: string }[]>(
      `select table_schema, table_name from information_schema.tables
       where table_name in ('ReviewTask','ReviewAssignment','SmtpConfig','NotificationLog')
       order by table_schema, table_name`,
    );
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.table_schema === 'policytracker')).toBe(true);
    expect(rows.some((r) => r.table_schema === 'public')).toBe(false);
  });
});
