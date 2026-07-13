import { createHash } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import request from 'supertest';
import { PERMISSIONS, ROLES } from '@policymanager/shared';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * End-to-end proof (against the running Postgres + MinIO) of the Documents &
 * Versioning slice:
 *  - title is required (400 without it),
 *  - a PDF upload is stored immutably with a correct sha256 checksum and queued
 *    for background extraction,
 *  - the list endpoint finds the document via filters,
 *  - download returns a short-lived presigned URL (never the raw bytes),
 *  - unauthenticated access is 401.
 *
 * NOTE: pdf.js sets up its worker via an ESM dynamic import, so this suite must
 * run with `--experimental-vm-modules` (baked into the `test:e2e` script) for
 * background PDF text extraction to succeed inside Jest. In the real Node
 * runtime no flag is needed.
 */
describe('Documents & Versioning (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const suffix = Date.now();
  const adminEmail = `e2e-doc-admin-${suffix}@policymanager.local`;
  const password = 'E2e-Pass!123';
  const createdUserIds: string[] = [];
  const createdDocIds: string[] = [];
  let token = '';

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

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitForExtractedText(docId: string, versionId: string) {
    let last: request.Response | null = null;
    for (let i = 0; i < 20; i++) {
      last = await request(app.getHttpServer())
        .get(`/api/documents/${docId}`)
        .set('Authorization', auth())
        .expect(200);
      if (
        last.body.currentVersion?.id === versionId &&
        last.body.currentVersion?.extractionStatus === 'done'
      ) {
        return last;
      }
      await sleep(250);
    }
    return last!;
  }

  async function ensureRbac(): Promise<string> {
    const permKeys = [PERMISSIONS.DOCUMENT_READ, PERMISSIONS.DOCUMENT_WRITE];
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
    return admin.id;
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
    const adminRoleId = await ensureRbac();

    const passwordHash = await argon2.hash(password);
    const user = await prisma.user.create({
      data: { email: adminEmail, name: 'Doc Admin', passwordHash, roles: { create: { roleId: adminRoleId } } },
    });
    createdUserIds.push(user.id);

    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: adminEmail, password })
      .expect(200);
    token = login.body.accessToken;
  }, 30000);

  afterAll(async () => {
    if (prisma) {
      await prisma.document.updateMany({
        where: { id: { in: createdDocIds } },
        data: { currentVersionId: null },
      });
      await prisma.documentVersion.deleteMany({ where: { documentId: { in: createdDocIds } } });
      await prisma.document.deleteMany({ where: { id: { in: createdDocIds } } });
      await prisma.refreshToken.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app?.close();
  });

  const auth = () => `Bearer ${token}`;

  it('rejects an unauthenticated list with 401', async () => {
    await request(app.getHttpServer()).get('/api/documents').expect(401);
  });

  it('rejects document creation without a title (400)', async () => {
    await request(app.getHttpServer())
      .post('/api/documents')
      .set('Authorization', auth())
      .send({ description: 'no title here' })
      .expect(400);
  });

  it('runs the full create -> upload PDF -> list -> download flow', async () => {
    const title = `Seclusion & Restraint Policy ${suffix}`;

    // Create.
    const created = await request(app.getHttpServer())
      .post('/api/documents')
      .set('Authorization', auth())
      .send({ title, documentNumber: `PP-${suffix}`, tags: ['CARF'] })
      .expect(201);
    const docId = created.body.id as string;
    createdDocIds.push(docId);
    expect(created.body.title).toBe(title);
    expect(created.body.status).toBe('draft');
    expect(created.body.currentVersion).toBeNull();

    // Upload a small PDF as version 1.
    const pdf = makePdf('Hello PolicyManager');
    const expectedChecksum = createHash('sha256').update(pdf).digest('hex');
    const uploaded = await request(app.getHttpServer())
      .post(`/api/documents/${docId}/versions`)
      .set('Authorization', auth())
      .field('changeSummary', 'Initial upload')
      .attach('file', pdf, { filename: 'policy.pdf', contentType: 'application/pdf' })
      .expect(201);

    expect(uploaded.body.versionNumber).toBe(1);
    expect(uploaded.body.checksum).toBe(expectedChecksum);
    expect(uploaded.body.sizeBytes).toBe(pdf.length);
    expect(uploaded.body.mimeType).toBe('application/pdf');
    // Upload does not block on extraction/OCR. The raw text is NOT returned.
    expect(uploaded.body.hasExtractedText).toBe(false);
    expect(uploaded.body.extractionStatus).toBe('pending');
    expect(uploaded.body.extractedText).toBeUndefined();
    const versionId = uploaded.body.id as string;

    // Detail eventually reflects background text extraction for search/RAG.
    const detail = await waitForExtractedText(docId, versionId);
    expect(detail.body.currentVersion.id).toBe(versionId);
    expect(detail.body.currentVersion.hasExtractedText).toBe(true);
    expect(detail.body.currentVersion.extractionStatus).toBe('done');
    expect(detail.body.versions).toHaveLength(1);

    // List with filters finds the document.
    const list = await request(app.getHttpServer())
      .get('/api/documents')
      .query({ q: String(suffix), status: 'draft', tag: 'CARF', sort: 'title', order: 'asc' })
      .set('Authorization', auth())
      .expect(200);
    expect(list.body.total).toBeGreaterThanOrEqual(1);
    expect(list.body.items.map((d: { id: string }) => d.id)).toContain(docId);

    // Download returns a short-lived presigned URL (not the bytes).
    const download = await request(app.getHttpServer())
      .get(`/api/documents/${docId}/versions/${versionId}/download`)
      .set('Authorization', auth())
      .expect(200);
    expect(typeof download.body.url).toBe('string');
    expect(download.body.url).toMatch(/^https?:\/\//);
    expect(download.body.expiresIn).toBeGreaterThan(0);
    expect(download.body.expiresIn).toBeLessThanOrEqual(300);
  }, 30000);

  it('runs the soft-delete -> restore -> archive -> version-restore lifecycle', async () => {
    const listContains = async (id: string, query: Record<string, unknown> = {}) => {
      const res = await request(app.getHttpServer())
        .get('/api/documents')
        .query({ q: `LC-${suffix}`, pageSize: 100, ...query })
        .set('Authorization', auth())
        .expect(200);
      return (res.body.items as { id: string }[]).some((d) => d.id === id);
    };
    const versionCount = async (id: string): Promise<number> => {
      const res = await request(app.getHttpServer())
        .get(`/api/documents/${id}`)
        .set('Authorization', auth())
        .expect(200);
      return res.body.versions.length as number;
    };
    const canDownload = async (id: string, versionId: string): Promise<boolean> => {
      const res = await request(app.getHttpServer())
        .get(`/api/documents/${id}/versions/${versionId}/download`)
        .set('Authorization', auth());
      return res.status === 200 && typeof res.body.url === 'string';
    };

    // Create + upload v1 and v2.
    const created = await request(app.getHttpServer())
      .post('/api/documents')
      .set('Authorization', auth())
      .send({ title: `Lifecycle LC-${suffix}` })
      .expect(201);
    const docId = created.body.id as string;
    createdDocIds.push(docId);

    const pdfV1 = makePdf('Lifecycle version one');
    const v1Checksum = createHash('sha256').update(pdfV1).digest('hex');
    const upV1 = await request(app.getHttpServer())
      .post(`/api/documents/${docId}/versions`)
      .set('Authorization', auth())
      .attach('file', pdfV1, { filename: 'v1.pdf', contentType: 'application/pdf' })
      .expect(201);
    const v1Id = upV1.body.id as string;

    const upV2 = await request(app.getHttpServer())
      .post(`/api/documents/${docId}/versions`)
      .set('Authorization', auth())
      .attach('file', makePdf('Lifecycle version two'), {
        filename: 'v2.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);
    const v2Id = upV2.body.id as string;
    expect(await versionCount(docId)).toBe(2);
    expect(await listContains(docId)).toBe(true);

    // --- Soft delete -------------------------------------------------------
    await request(app.getHttpServer())
      .delete(`/api/documents/${docId}`)
      .set('Authorization', auth())
      .expect(200);
    // Excluded from the default list, but present in the trash view.
    expect(await listContains(docId)).toBe(false);
    expect(await listContains(docId, { deleted: true })).toBe(true);
    // A soft-deleted document reads as 404 via the normal route.
    await request(app.getHttpServer())
      .get(`/api/documents/${docId}`)
      .set('Authorization', auth())
      .expect(404);
    // ...and its versions are not downloadable while trashed.
    await request(app.getHttpServer())
      .get(`/api/documents/${docId}/versions/${v1Id}/download`)
      .set('Authorization', auth())
      .expect(404);
    // Rows and bytes are preserved — the version count is untouched.
    const trashed = await prisma.documentVersion.count({ where: { documentId: docId } });
    expect(trashed).toBe(2);

    // --- Restore -----------------------------------------------------------
    await request(app.getHttpServer())
      .post(`/api/documents/${docId}/restore`)
      .set('Authorization', auth())
      .expect(200);
    expect(await listContains(docId)).toBe(true);
    expect(await versionCount(docId)).toBe(2);

    // --- Archive -----------------------------------------------------------
    await request(app.getHttpServer())
      .post(`/api/documents/${docId}/archive`)
      .set('Authorization', auth())
      .expect(200);
    // Excluded from the default list, present with status=archived, downloadable.
    expect(await listContains(docId)).toBe(false);
    expect(await listContains(docId, { status: 'archived' })).toBe(true);
    expect(await listContains(docId, { includeArchived: true })).toBe(true);
    expect(await canDownload(docId, v1Id)).toBe(true);

    // Unarchive returns it to the active list with its prior (draft) status.
    await request(app.getHttpServer())
      .post(`/api/documents/${docId}/unarchive`)
      .set('Authorization', auth())
      .expect(200);
    expect(await listContains(docId)).toBe(true);

    // --- Restore version v1 (creates a NEW v3 current) ---------------------
    const beforeRestore = await versionCount(docId);
    const restored = await request(app.getHttpServer())
      .post(`/api/documents/${docId}/versions/${v1Id}/restore`)
      .set('Authorization', auth())
      .expect(201);
    expect(restored.body.versionNumber).toBe(3);
    expect(restored.body.changeSummary).toBe('Restored from v1');
    // Identical bytes ⇒ identical checksum carried forward from v1.
    expect(restored.body.checksum).toBe(v1Checksum);
    const v3Id = restored.body.id as string;

    // The version count only ever GROWS; history is preserved.
    const afterRestore = await versionCount(docId);
    expect(afterRestore).toBe(beforeRestore + 1);
    expect(afterRestore).toBe(3);

    // Detail shows v3 as current, and v1/v2/v3 are all still present + downloadable.
    const detail = await request(app.getHttpServer())
      .get(`/api/documents/${docId}`)
      .set('Authorization', auth())
      .expect(200);
    expect(detail.body.currentVersion.id).toBe(v3Id);
    const versionIds = (detail.body.versions as { id: string }[]).map((v) => v.id);
    expect(versionIds).toEqual(expect.arrayContaining([v1Id, v2Id, v3Id]));
    expect(await canDownload(docId, v1Id)).toBe(true);
    expect(await canDownload(docId, v2Id)).toBe(true);
    expect(await canDownload(docId, v3Id)).toBe(true);

    // The restored version is a NEW row/object — the original v1 row is intact.
    const v1Row = await prisma.documentVersion.findUnique({ where: { id: v1Id } });
    const v3Row = await prisma.documentVersion.findUnique({ where: { id: v3Id } });
    expect(v1Row).not.toBeNull();
    expect(v3Row?.s3Key).not.toBe(v1Row?.s3Key); // copied to a new key, not moved
    expect(v3Row?.checksum).toBe(v1Row?.checksum); // identical bytes
  }, 45000);

  it('C1/D6: two concurrent version uploads get DISTINCT numbers (or one clean 409), never a 500 or byte overwrite', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/documents')
      .set('Authorization', auth())
      .send({ title: `Concurrent CC-${suffix}` })
      .expect(201);
    const docId = created.body.id as string;
    createdDocIds.push(docId);

    const upload = (n: number) =>
      request(app.getHttpServer())
        .post(`/api/documents/${docId}/versions`)
        .set('Authorization', auth())
        .attach('file', makePdf(`Concurrent body ${n}`), {
          filename: `cc-${n}.pdf`,
          contentType: 'application/pdf',
        });

    // Fire both at once against the same (empty) document.
    const [r1, r2] = await Promise.all([upload(1), upload(2)]);

    // Neither is a raw 500 — the row lock serializes and the P2002 backstop maps to 409.
    expect(r1.status).not.toBe(500);
    expect(r2.status).not.toBe(500);
    for (const r of [r1, r2]) expect([201, 409]).toContain(r.status);

    // Successful uploads have DISTINCT version numbers...
    const numbers = [r1, r2].filter((r) => r.status === 201).map((r) => r.body.versionNumber);
    expect(new Set(numbers).size).toBe(numbers.length);

    // ...and the DB never holds two versions with the same number for this doc.
    const versions = await prisma.documentVersion.findMany({
      where: { documentId: docId },
      select: { versionNumber: true, s3Key: true },
    });
    const dbNumbers = versions.map((v) => v.versionNumber);
    expect(new Set(dbNumbers).size).toBe(dbNumbers.length);
    // Distinct numbers ⇒ distinct deterministic keys ⇒ no byte overwrite.
    const keys = versions.map((v) => v.s3Key);
    expect(new Set(keys).size).toBe(keys.length);
  }, 30000);

  it('C4/D3: a document number freed by soft-delete can be reused by a new document', async () => {
    const num = `PP-REUSE-${suffix}`;
    const first = await request(app.getHttpServer())
      .post('/api/documents')
      .set('Authorization', auth())
      .send({ title: `Reuse First ${suffix}`, documentNumber: num })
      .expect(201);
    createdDocIds.push(first.body.id);

    // Soft-delete frees the number (the unique is partial: WHERE deletedAt IS NULL).
    await request(app.getHttpServer())
      .delete(`/api/documents/${first.body.id}`)
      .set('Authorization', auth())
      .expect(200);

    // A brand-new document may now take the same number (previously a false 409).
    const second = await request(app.getHttpServer())
      .post('/api/documents')
      .set('Authorization', auth())
      .send({ title: `Reuse Second ${suffix}`, documentNumber: num })
      .expect(201);
    createdDocIds.push(second.body.id);
    expect(second.body.documentNumber).toBe(num);

    // But two ACTIVE documents still cannot share the number.
    await request(app.getHttpServer())
      .post('/api/documents')
      .set('Authorization', auth())
      .send({ title: `Reuse Third ${suffix}`, documentNumber: num })
      .expect(409);
  }, 30000);
});
