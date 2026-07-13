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
 *  - a PDF upload is stored immutably with a correct sha256 checksum and has
 *    extracted text,
 *  - the list endpoint finds the document via filters,
 *  - download returns a short-lived presigned URL (never the raw bytes),
 *  - unauthenticated access is 401.
 *
 * NOTE: pdf.js sets up its worker via an ESM dynamic import, so this suite must
 * run with `--experimental-vm-modules` (baked into the `test:e2e` script) for
 * PDF text extraction to succeed inside Jest. In the real Node runtime no flag
 * is needed.
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
    // Text was extracted from the PDF (RAG-ready). The raw text is NOT returned.
    expect(uploaded.body.hasExtractedText).toBe(true);
    expect(uploaded.body.extractedText).toBeUndefined();
    const versionId = uploaded.body.id as string;

    // Detail now reflects the current version + history.
    const detail = await request(app.getHttpServer())
      .get(`/api/documents/${docId}`)
      .set('Authorization', auth())
      .expect(200);
    expect(detail.body.currentVersion.id).toBe(versionId);
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
});
