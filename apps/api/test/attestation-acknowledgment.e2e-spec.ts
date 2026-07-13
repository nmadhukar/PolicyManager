import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import request from 'supertest';
import { PERMISSIONS, ROLES } from '@policymanager/shared';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * End-to-end proof (live Postgres + MinIO + Gotenberg) of Phase 6 — attestation
 * sign-off, cover page/export, and staff acknowledgment distribution:
 *
 *  - a published document's review completion records an immutable `reviewed`
 *    Attestation; approval records an `approved` Attestation and sets the status;
 *  - the compliance cover page and the cover-prepended export are valid PDFs;
 *  - distribution appears in the assignee's /acknowledgments, cannot be
 *    acknowledged before viewing, and on acknowledge records an `acknowledged`
 *    Attestation + completes the assignment;
 *  - publishing a NEW version re-triggers a fresh pending acknowledgment;
 *  - attestations have no update/delete route; a non-approver is forbidden (403),
 *    unauthenticated is 401; and the new tables live in `policytracker`.
 */

/** Collects a binary (PDF) response body into a Buffer. */
function binaryParser(
  res: request.Response,
  cb: (err: Error | null, body: Buffer) => void,
): void {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}

async function makePdf(text: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([300, 300]);
  page.drawText(text, { x: 30, y: 150, size: 14, font });
  return Buffer.from(await doc.save());
}

describe('Attestation, cover page & acknowledgment (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const suffix = Date.now();
  const adminEmail = `e2e-att-admin-${suffix}@policymanager.local`;
  const staffEmail = `e2e-att-staff-${suffix}@policymanager.local`;
  const password = 'E2e-Pass!123';

  const createdUserIds: string[] = [];
  const createdDocIds: string[] = [];
  let adminToken = '';
  let staffToken = '';
  let staffId = '';
  let docId = '';
  let v1Id = '';

  async function ensureRbac(): Promise<{ adminRoleId: string; staffRoleId: string }> {
    const permKeys = [
      PERMISSIONS.DOCUMENT_READ,
      PERMISSIONS.DOCUMENT_WRITE,
      PERMISSIONS.DOCUMENT_APPROVE,
      PERMISSIONS.REVIEW_MANAGE,
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
    // Staff gets ONLY document.read (no approve, no review.manage).
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
  }, 60000);

  afterAll(async () => {
    if (prisma) {
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
    }
    await app?.close();
  });

  const asAdmin = () => `Bearer ${adminToken}`;
  const asStaff = () => `Bearer ${staffToken}`;

  it('creates a quarterly document and uploads its first PDF version', async () => {
    // No nextReviewDate: this document is intentionally kept OUT of the global
    // review sweep so this suite stays isolated from the review-scheduling suite
    // (the sweep is exercised there). We seed a review task directly below.
    const created = await request(app.getHttpServer())
      .post('/api/documents')
      .set('Authorization', asAdmin())
      .send({ title: `Sign-off Policy ${suffix}`, reviewCadence: 'quarterly' })
      .expect(201);
    docId = created.body.id;
    createdDocIds.push(docId);

    const pdf = await makePdf('Version 1 body');
    const uploaded = await request(app.getHttpServer())
      .post(`/api/documents/${docId}/versions`)
      .set('Authorization', asAdmin())
      .attach('file', pdf, 'policy-v1.pdf')
      .expect(201);
    v1Id = uploaded.body.id;
    expect(uploaded.body.versionNumber).toBe(1);
  }, 30000);

  it('review completion records an immutable reviewed Attestation tied to the version', async () => {
    // Seed a review task directly (the sweep itself is covered by the review suite),
    // then complete it — completion must record the reviewer sign-off.
    const task = await prisma.reviewTask.create({
      data: {
        documentId: docId,
        versionId: v1Id,
        dueDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
        assignedToId: staffId,
        status: 'pending',
      },
    });

    await request(app.getHttpServer())
      .post(`/api/reviews/${task.id}/complete`)
      .set('Authorization', asStaff())
      .send({ notes: 'Reviewed for e2e', signatureName: 'Sam Staff', signatureRole: 'RN' })
      .expect(200);

    const reviewed = await prisma.attestation.findFirst({
      where: { documentId: docId, action: 'reviewed' },
    });
    expect(reviewed).toBeTruthy();
    expect(reviewed?.versionId).toBe(v1Id);
    expect(reviewed?.signatureName).toBe('Sam Staff');
    expect(reviewed?.reviewTaskId).toBe(task.id);
  }, 30000);

  it('approve records an approved Attestation and sets the document status', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/documents/${docId}/approve`)
      .set('Authorization', asAdmin())
      .send({ comments: 'Approved for e2e', signatureRole: 'Compliance Officer' })
      .expect(200);
    expect(res.body.status).toBe('approved');
    expect(res.body.attestation.action).toBe('approved');

    // The approval chain endpoint returns reviewed + approved, newest first.
    const chain = await request(app.getHttpServer())
      .get(`/api/documents/${docId}/attestations`)
      .set('Authorization', asAdmin())
      .expect(200);
    const actions = (chain.body as { action: string }[]).map((a) => a.action);
    expect(actions).toContain('approved');
    expect(actions).toContain('reviewed');

    const doc = await request(app.getHttpServer())
      .get(`/api/documents/${docId}`)
      .set('Authorization', asAdmin())
      .expect(200);
    expect(doc.body.status).toBe('approved');
  });

  it('GET cover-page returns a valid PDF', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/documents/${docId}/cover-page`)
      .set('Authorization', asAdmin())
      .buffer()
      .parse(binaryParser)
      .expect(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('GET export returns a valid merged PDF (cover + version pages)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/documents/${docId}/export`)
      .set('Authorization', asAdmin())
      .buffer()
      .parse(binaryParser)
      .expect(200);
    expect(res.body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const parsed = await PDFDocument.load(res.body);
    // Cover page(s) + the single-page source version => at least 2 pages.
    expect(parsed.getPageCount()).toBeGreaterThanOrEqual(2);
  });

  it('distributes for acknowledgment; it appears in the assignee\'s list and gates on viewing', async () => {
    const dist = await request(app.getHttpServer())
      .post(`/api/documents/${docId}/acknowledgments`)
      .set('Authorization', asAdmin())
      .send({ assigneeIds: [staffId] })
      .expect(201);
    expect(dist.body.total).toBe(1);
    expect(dist.body.percentComplete).toBe(0);

    const mine = await request(app.getHttpServer())
      .get('/api/acknowledgments')
      .query({ mine: true })
      .set('Authorization', asStaff())
      .expect(200);
    const pending = (mine.body as { id: string; status: string; versionId: string }[]).find(
      (a) => a.versionId === v1Id,
    );
    expect(pending).toBeDefined();
    expect(pending!.status).toBe('pending');

    // Cannot acknowledge before viewing (hasViewed must be true).
    await request(app.getHttpServer())
      .post(`/api/acknowledgments/${pending!.id}/acknowledge`)
      .set('Authorization', asStaff())
      .send({ hasViewed: false })
      .expect(400);

    // View the document (issues a view-url), then acknowledge.
    await request(app.getHttpServer())
      .get(`/api/documents/${docId}/versions/${v1Id}/view-url`)
      .set('Authorization', asStaff())
      .expect(200);

    const ack = await request(app.getHttpServer())
      .post(`/api/acknowledgments/${pending!.id}/acknowledge`)
      .set('Authorization', asStaff())
      .send({ hasViewed: true, signatureRole: 'Nurse' })
      .expect(200);
    expect(ack.body.assignment.status).toBe('completed');
    expect(ack.body.attestation.action).toBe('acknowledged');

    const acknowledged = await prisma.attestation.findFirst({
      where: { documentId: docId, action: 'acknowledged', userId: staffId },
    });
    expect(acknowledged?.versionId).toBe(v1Id);
    expect(acknowledged?.acknowledgmentAssignmentId).toBe(pending!.id);
  }, 30000);

  it('manager status view shows 100% complete after the acknowledgment', async () => {
    const status = await request(app.getHttpServer())
      .get(`/api/documents/${docId}/acknowledgments`)
      .set('Authorization', asAdmin())
      .expect(200);
    expect(status.body.total).toBe(1);
    expect(status.body.completed).toBe(1);
    expect(status.body.percentComplete).toBe(100);
  });

  it('publishing a NEW version re-triggers a fresh pending acknowledgment for the assignee', async () => {
    // Upload v2 (becomes current), then publish.
    const pdf = await makePdf('Version 2 body');
    const uploaded = await request(app.getHttpServer())
      .post(`/api/documents/${docId}/versions`)
      .set('Authorization', asAdmin())
      .attach('file', pdf, 'policy-v2.pdf')
      .expect(201);
    const v2Id = uploaded.body.id;

    const published = await request(app.getHttpServer())
      .post(`/api/documents/${docId}/approve`)
      .set('Authorization', asAdmin())
      .send({ publish: true })
      .expect(200);
    expect(published.body.status).toBe('published');
    expect(published.body.acknowledgmentsRetriggered).toBe(1);

    // The assignee now has a fresh PENDING acknowledgment for v2 (v1 stays completed).
    const mine = await request(app.getHttpServer())
      .get('/api/acknowledgments')
      .query({ mine: true })
      .set('Authorization', asStaff())
      .expect(200);
    const items = mine.body as { versionId: string; status: string }[];
    const v2Pending = items.find((a) => a.versionId === v2Id);
    const v1Completed = items.find((a) => a.versionId === v1Id);
    expect(v2Pending?.status).toBe('pending');
    expect(v1Completed?.status).toBe('completed');
  }, 30000);

  it('attestations are immutable: no update/delete route exists (404)', async () => {
    const att = await prisma.attestation.findFirst({ where: { documentId: docId, action: 'approved' } });
    expect(att).toBeTruthy();
    await request(app.getHttpServer())
      .delete(`/api/documents/${docId}/attestations/${att!.id}`)
      .set('Authorization', asAdmin())
      .expect(404);
    await request(app.getHttpServer())
      .delete(`/api/attestations/${att!.id}`)
      .set('Authorization', asAdmin())
      .expect(404);
    await request(app.getHttpServer())
      .patch(`/api/documents/${docId}/attestations/${att!.id}`)
      .set('Authorization', asAdmin())
      .send({ signatureName: 'tampered' })
      .expect(404);
  });

  it('enforces RBAC: 403 for a non-approver on approve, 401 unauthenticated', async () => {
    // Staff (document.read only) cannot approve or distribute.
    await request(app.getHttpServer())
      .post(`/api/documents/${docId}/approve`)
      .set('Authorization', asStaff())
      .send({})
      .expect(403);
    await request(app.getHttpServer())
      .post(`/api/documents/${docId}/acknowledgments`)
      .set('Authorization', asStaff())
      .send({ assigneeIds: [staffId] })
      .expect(403);
    await request(app.getHttpServer())
      .get(`/api/documents/${docId}/acknowledgments`)
      .set('Authorization', asStaff())
      .expect(403);

    // Unauthenticated is 401.
    await request(app.getHttpServer()).get('/api/acknowledgments').expect(401);
    await request(app.getHttpServer()).post(`/api/documents/${docId}/approve`).send({}).expect(401);
  });

  it('Schema proof: new tables live in policytracker, never public', async () => {
    const rows = await prisma.$queryRawUnsafe<{ table_schema: string; table_name: string }[]>(
      `select table_schema, table_name from information_schema.tables
       where table_name in ('Attestation','AcknowledgmentAssignment')
       order by table_schema, table_name`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.table_schema === 'policytracker')).toBe(true);
    expect(rows.some((r) => r.table_schema === 'public')).toBe(false);
  });
});
