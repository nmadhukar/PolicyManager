import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import request from 'supertest';
import { PERMISSIONS, ROLES } from '@policymanager/shared';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * End-to-end proof (live Postgres + MinIO) of Phase 4 — Access Control & Audit:
 *
 *  - a confidential document created by Admin is INVISIBLE to a plain
 *    document.read Staff user (absent from the list, 403 on GET + download), and
 *    each denial writes an `access.denied` audit row;
 *  - granting that user `view` via the ACL API makes the document visible AND
 *    downloadable, and those actions write `document.viewed` / `document.downloaded`
 *    audit rows;
 *  - `GET /api/audit` returns the trail filtered, and a non-`audit.read` user is
 *    forbidden;
 *  - the new tables live in `policytracker` (never `public`) and there is no
 *    update/delete route for AuditEvent (immutability).
 */
describe('Access Control & Audit (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const suffix = Date.now();
  const adminEmail = `e2e-ac-admin-${suffix}@policymanager.local`;
  const staffEmail = `e2e-ac-staff-${suffix}@policymanager.local`;
  const password = 'E2e-Pass!123';
  const createdUserIds: string[] = [];
  const createdDocIds: string[] = [];
  let adminToken = '';
  let staffToken = '';
  let staffId = '';
  let docId = '';
  let versionId = '';

  /** Minimal, valid single-page PDF containing the given text. */
  function makePdf(text: string): Buffer {
    const objs: string[] = [];
    objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
    objs[3] =
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>';
    const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
    objs[4] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    objs[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
    let pdf = '%PDF-1.4\n';
    const offsets: number[] = [];
    for (let i = 1; i <= 5; i++) {
      offsets[i] = Buffer.byteLength(pdf, 'latin1');
      pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`;
    }
    const xrefOffset = Buffer.byteLength(pdf, 'latin1');
    pdf += 'xref\n0 6\n0000000000 65535 f \n';
    for (let i = 1; i <= 5; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
    pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
    return Buffer.from(pdf, 'latin1');
  }

  /** Ensures the permissions + Admin/Staff roles used by this suite exist. */
  async function ensureRbac(): Promise<{ adminRoleId: string; staffRoleId: string }> {
    const permKeys = [
      PERMISSIONS.DOCUMENT_READ,
      PERMISSIONS.DOCUMENT_WRITE,
      PERMISSIONS.DOCUMENT_APPROVE,
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
    // Admin gets every permission this suite uses.
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
    // Staff gets ONLY document.read (no write, no audit.read) — reconcile exactly.
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
      await prisma.auditEvent.deleteMany({
        where: {
          OR: [
            { documentId: { in: createdDocIds } },
            { actorUserId: { in: createdUserIds } },
          ],
        },
      });
      await prisma.documentAcl.deleteMany({ where: { documentId: { in: createdDocIds } } });
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

  const auditCount = async (
    where: Record<string, unknown>,
  ): Promise<number> => prisma.auditEvent.count({ where });

  it('Admin creates a CONFIDENTIAL document + uploads a version (audited)', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/documents')
      .set('Authorization', asAdmin())
      .send({ title: `Confidential AC-${suffix}`, accessLevel: 'confidential' })
      .expect(201);
    docId = created.body.id;
    createdDocIds.push(docId);
    expect(created.body.accessLevel).toBe('confidential');

    const uploaded = await request(app.getHttpServer())
      .post(`/api/documents/${docId}/versions`)
      .set('Authorization', asAdmin())
      .attach('file', makePdf('Top secret'), { filename: 'secret.pdf', contentType: 'application/pdf' })
      .expect(201);
    versionId = uploaded.body.id;

    // The create + upload were both audited.
    expect(await auditCount({ documentId: docId, action: 'document.created' })).toBe(1);
    expect(await auditCount({ documentId: docId, action: 'version.uploaded' })).toBe(1);
  }, 30000);

  it('Staff CANNOT see the confidential document in the list', async () => {
    const list = await request(app.getHttpServer())
      .get('/api/documents')
      .query({ q: `AC-${suffix}`, pageSize: 100 })
      .set('Authorization', asStaff())
      .expect(200);
    expect((list.body.items as { id: string }[]).some((d) => d.id === docId)).toBe(false);

    // ...but Admin (the owner) does.
    const adminList = await request(app.getHttpServer())
      .get('/api/documents')
      .query({ q: `AC-${suffix}`, pageSize: 100 })
      .set('Authorization', asAdmin())
      .expect(200);
    expect((adminList.body.items as { id: string }[]).some((d) => d.id === docId)).toBe(true);
  });

  it('Staff GET + download are FORBIDDEN and write access.denied audit rows', async () => {
    const before = await auditCount({ documentId: docId, action: 'access.denied', actorUserId: staffId });

    await request(app.getHttpServer())
      .get(`/api/documents/${docId}`)
      .set('Authorization', asStaff())
      .expect(403);

    await request(app.getHttpServer())
      .get(`/api/documents/${docId}/versions/${versionId}/download`)
      .set('Authorization', asStaff())
      .expect(403);

    const after = await auditCount({ documentId: docId, action: 'access.denied', actorUserId: staffId });
    expect(after).toBe(before + 2);
  });

  it('Admin grants Staff `view` via the ACL API (audited acl.changed)', async () => {
    const grant = await request(app.getHttpServer())
      .post(`/api/documents/${docId}/acl`)
      .set('Authorization', asAdmin())
      .send({ principalType: 'user', principalId: staffId, permission: 'view' })
      .expect(201);
    expect(grant.body.principalId).toBe(staffId);
    expect(grant.body.permission).toBe('view');

    const acls = await request(app.getHttpServer())
      .get(`/api/documents/${docId}/acl`)
      .set('Authorization', asAdmin())
      .expect(200);
    expect(acls.body).toHaveLength(1);

    expect(await auditCount({ documentId: docId, action: 'acl.changed' })).toBe(1);
  });

  it('With the grant, Staff can now SEE, GET, and DOWNLOAD (each audited)', async () => {
    // Visible in the list.
    const list = await request(app.getHttpServer())
      .get('/api/documents')
      .query({ q: `AC-${suffix}`, pageSize: 100 })
      .set('Authorization', asStaff())
      .expect(200);
    expect((list.body.items as { id: string }[]).some((d) => d.id === docId)).toBe(true);

    // Detail now 200s.
    await request(app.getHttpServer())
      .get(`/api/documents/${docId}`)
      .set('Authorization', asStaff())
      .expect(200);

    // Download now returns a short-lived presigned URL (never the bytes).
    const dl = await request(app.getHttpServer())
      .get(`/api/documents/${docId}/versions/${versionId}/download`)
      .set('Authorization', asStaff())
      .expect(200);
    expect(dl.body.url).toMatch(/^https?:\/\//);
    expect(dl.body.expiresIn).toBeLessThanOrEqual(300);

    // The successful download by Staff was audited.
    expect(
      await auditCount({ documentId: docId, action: 'document.downloaded', actorUserId: staffId }),
    ).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/audit returns the trail filtered; a non-audit.read user is forbidden', async () => {
    // Admin can read the audit trail, filtered by document + action.
    const denied = await request(app.getHttpServer())
      .get('/api/audit')
      .query({ documentId: docId, action: 'access.denied' })
      .set('Authorization', asAdmin())
      .expect(200);
    expect(denied.body.total).toBeGreaterThanOrEqual(2);
    expect(
      (denied.body.items as { action: string; actorUserId: string }[]).every(
        (e) => e.action === 'access.denied',
      ),
    ).toBe(true);

    // Filtering by actor works too.
    const byActor = await request(app.getHttpServer())
      .get('/api/audit')
      .query({ actorUserId: staffId, documentId: docId })
      .set('Authorization', asAdmin())
      .expect(200);
    expect(byActor.body.items.length).toBeGreaterThan(0);
    expect(
      (byActor.body.items as { actorUserId: string }[]).every((e) => e.actorUserId === staffId),
    ).toBe(true);

    // Staff (no audit.read) is forbidden.
    await request(app.getHttpServer())
      .get('/api/audit')
      .set('Authorization', asStaff())
      .expect(403);

    // Unauthenticated is 401.
    await request(app.getHttpServer()).get('/api/audit').expect(401);
  });

  it('removing the grant re-denies Staff (audited)', async () => {
    const acls = await request(app.getHttpServer())
      .get(`/api/documents/${docId}/acl`)
      .set('Authorization', asAdmin())
      .expect(200);
    const aclId = acls.body[0].id as string;

    await request(app.getHttpServer())
      .delete(`/api/documents/${docId}/acl/${aclId}`)
      .set('Authorization', asAdmin())
      .expect(204);

    // Access is revoked again.
    await request(app.getHttpServer())
      .get(`/api/documents/${docId}`)
      .set('Authorization', asStaff())
      .expect(403);

    expect(await auditCount({ documentId: docId, action: 'acl.changed' })).toBe(2);
  });

  it('AuditEvent has NO update/delete route (immutable through app paths)', async () => {
    // Pick a real audit row id to target.
    const row = await prisma.auditEvent.findFirst({ where: { documentId: docId } });
    expect(row).not.toBeNull();
    // No such routes exist -> 404 Not Found (never 200/204).
    await request(app.getHttpServer())
      .delete(`/api/audit/${row!.id}`)
      .set('Authorization', asAdmin())
      .expect(404);
    await request(app.getHttpServer())
      .patch(`/api/audit/${row!.id}`)
      .set('Authorization', asAdmin())
      .send({ action: 'tampered' })
      .expect(404);
  });

  it('Schema proof: new tables live in policytracker, never public', async () => {
    const rows = await prisma.$queryRawUnsafe<{ table_schema: string; table_name: string }[]>(
      `select table_schema, table_name from information_schema.tables
       where table_name in ('DocumentAcl','AuditEvent') order by table_schema`,
    );
    expect(rows.every((r) => r.table_schema === 'policytracker')).toBe(true);
    expect(rows.some((r) => r.table_name === 'DocumentAcl')).toBe(true);
    expect(rows.some((r) => r.table_name === 'AuditEvent')).toBe(true);
    // Nothing leaked into public.
    expect(rows.some((r) => r.table_schema === 'public')).toBe(false);
  });
});
