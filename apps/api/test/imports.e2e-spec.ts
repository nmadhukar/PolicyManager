import { createHash } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import request from 'supertest';
import { PERMISSIONS, ROLES } from '@policymanager/shared';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * End-to-end proof of Import & Consolidation (Phase 8) against the running Postgres
 * + MinIO. Exercises the whole contract:
 *   POST /api/imports with a 3-row manifest (one new PDF, one duplicate document
 *   number, one row whose file was not uploaded) → one created, one duplicate, one
 *   error, with correct batch counters; the created document is a real, retrievable
 *   Document with version 1 and the right checksum; its category was auto-created;
 *   GET /api/imports/:id returns the per-row report; re-running the SAME manifest
 *   creates nothing (idempotent by number/checksum); the bulk route creates from a
 *   filename and then de-duplicates by checksum; unauthenticated is 401 and a
 *   non-`document.write` user is 403.
 *
 * NOTE: PDF text extraction uses pdf.js's ESM worker, so this suite must run with
 * `--experimental-vm-modules` (baked into the `test:e2e` script).
 */
describe('Import & Consolidation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const suffix = Date.now();
  const importerEmail = `e2e-import-admin-${suffix}@policymanager.local`;
  const readerEmail = `e2e-import-reader-${suffix}@policymanager.local`;
  const password = 'E2e-Pass!123';
  const readerRoleName = `e2e-import-reader-role-${suffix}`;

  const createdUserIds: string[] = [];
  const createdDocIds: string[] = [];
  const createdBatchIds: string[] = [];
  let readerRoleId = '';

  let importerToken = '';
  let readerToken = '';
  let existingDupId = '';

  // Manifest file names (must match the attached upload filenames exactly).
  const newFile = `new-${suffix}.pdf`;
  const dupFile = `dup-${suffix}.pdf`;
  const ghostFile = `ghost-${suffix}.pdf`;
  const dupNumber = `PP-DUP-${suffix}`;
  const newNumber = `PP-NEW-${suffix}`;
  const leafCategory = `Clinical-${suffix}`;
  const categoryPath = `Imported-${suffix}/${leafCategory}`;

  const newPdf = makePdf(`New imported policy ${suffix}`);
  const dupPdf = makePdf(`Duplicate row file ${suffix}`);
  const newChecksum = createHash('sha256').update(newPdf).digest('hex');

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

  async function ensureRbac(): Promise<{ adminRoleId: string; readerRoleId: string }> {
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
    // A read-only role (document.read WITHOUT document.write) for the 403 test.
    const reader = await prisma.role.create({ data: { name: readerRoleName } });
    await prisma.rolePermission.create({
      data: { roleId: reader.id, permissionId: permIds[PERMISSIONS.DOCUMENT_READ] },
    });
    return { adminRoleId: admin.id, readerRoleId: reader.id };
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
    const { adminRoleId, readerRoleId: rrid } = await ensureRbac();
    readerRoleId = rrid;

    const importerId = await makeUser(importerEmail, adminRoleId);
    await makeUser(readerEmail, readerRoleId);

    // Pre-existing document holding the number the manifest's row 2 will collide with.
    const dupe = await prisma.document.create({
      data: {
        title: `Existing Dupe ${suffix}`,
        documentNumber: dupNumber,
        ownerId: importerId,
        accessLevel: 'restricted',
        tags: [],
      },
    });
    existingDupId = dupe.id;
    createdDocIds.push(dupe.id);

    importerToken = await login(importerEmail);
    readerToken = await login(readerEmail);
  }, 45000);

  afterAll(async () => {
    if (prisma) {
      await prisma.importBatch.deleteMany({ where: { id: { in: createdBatchIds } } });
      await prisma.document.updateMany({
        where: { id: { in: createdDocIds } },
        data: { currentVersionId: null },
      });
      await prisma.documentVersion.deleteMany({ where: { documentId: { in: createdDocIds } } });
      await prisma.document.deleteMany({ where: { id: { in: createdDocIds } } });
      // Auto-created categories (children before parents to respect the FK).
      const cats = await prisma.documentCategory.findMany({
        where: { name: { contains: `-${suffix}` } },
        select: { id: true, parentId: true },
      });
      for (const c of cats.filter((c) => c.parentId)) {
        await prisma.documentCategory.delete({ where: { id: c.id } }).catch(() => undefined);
      }
      for (const c of cats.filter((c) => !c.parentId)) {
        await prisma.documentCategory.delete({ where: { id: c.id } }).catch(() => undefined);
      }
      await prisma.refreshToken.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
      await prisma.rolePermission.deleteMany({ where: { roleId: readerRoleId } });
      await prisma.role.deleteMany({ where: { id: readerRoleId } });
    }
    await app?.close();
  });

  const manifestCsv = () =>
    [
      'fileName,title,category,documentNumber,accessLevel,tags',
      `${newFile},New Imported Policy ${suffix},${categoryPath},${newNumber},restricted,CARF;safety`,
      `${dupFile},Duplicate Row ${suffix},,${dupNumber},restricted,`,
      `${ghostFile},Missing File Row ${suffix},,,,`,
      '',
    ].join('\n');

  const postManifest = (token: string) =>
    request(app.getHttpServer())
      .post('/api/imports')
      .set('Authorization', `Bearer ${token}`)
      .attach('manifest', Buffer.from(manifestCsv()), {
        filename: 'manifest.csv',
        contentType: 'text/csv',
      })
      .attach('files', newPdf, { filename: newFile, contentType: 'application/pdf' })
      .attach('files', dupPdf, { filename: dupFile, contentType: 'application/pdf' });

  it('rejects an unauthenticated import (401)', async () => {
    await request(app.getHttpServer()).post('/api/imports').expect(401);
    await request(app.getHttpServer()).get('/api/imports').expect(401);
  });

  it('forbids a user without document.write (403), on both write and read routes', async () => {
    await request(app.getHttpServer())
      .post('/api/imports')
      .set('Authorization', `Bearer ${readerToken}`)
      .attach('manifest', Buffer.from('title\nX\n'), {
        filename: 'm.csv',
        contentType: 'text/csv',
      })
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/imports')
      .set('Authorization', `Bearer ${readerToken}`)
      .expect(403);
  });

  let createdDocId = '';

  it('imports a manifest: 1 created, 1 duplicate (by number), 1 error (missing file)', async () => {
    const res = await postManifest(importerToken).expect(201);
    createdBatchIds.push(res.body.id);

    expect(res.body.totalRows).toBe(3);
    expect(res.body.createdCount).toBe(1);
    expect(res.body.duplicateCount).toBe(1);
    expect(res.body.errorCount).toBe(1);
    expect(res.body.status).toBe('completed');
    expect(res.body.items).toHaveLength(3);

    interface ReportItem {
      status: string;
      documentId: string | null;
      fileName: string | null;
      message: string | null;
    }
    const items = res.body.items as ReportItem[];
    const byStatus = (s: string) => items.filter((i) => i.status === s);

    const created = byStatus('created')[0];
    expect(created.fileName).toBe(newFile);
    expect(created.documentId).toBeTruthy();
    createdDocId = created.documentId as string;
    createdDocIds.push(createdDocId);

    const duplicate = byStatus('duplicate')[0];
    expect(duplicate.documentId).toBe(existingDupId);
    expect(duplicate.message).toMatch(/document number/i);

    const errored = byStatus('error')[0];
    expect(errored.fileName).toBe(ghostFile);
    expect(errored.message).toMatch(/not uploaded/i);
  }, 60000);

  it('exposes the batch report via GET /api/imports/:id', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/imports/${createdBatchIds[0]}`)
      .set('Authorization', `Bearer ${importerToken}`)
      .expect(200);
    expect(res.body.id).toBe(createdBatchIds[0]);
    expect(res.body.items).toHaveLength(3);
    // Ordered by row number (deterministic report).
    expect((res.body.items as { rowNumber: number }[]).map((i) => i.rowNumber)).toEqual([1, 2, 3]);
  });

  it('created a real, retrievable document (version 1, correct checksum, auto-category)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/documents/${createdDocId}`)
      .set('Authorization', `Bearer ${importerToken}`)
      .expect(200);
    expect(res.body.documentNumber).toBe(newNumber);
    expect(res.body.categoryName).toBe(leafCategory);
    expect(res.body.tags).toEqual(expect.arrayContaining(['CARF', 'safety']));
    expect(res.body.currentVersion.versionNumber).toBe(1);
    expect(res.body.currentVersion.checksum).toBe(newChecksum);
    expect(res.body.currentVersion.fileName).toBe(newFile);
  });

  it('re-running the SAME manifest creates nothing (idempotent by number/checksum)', async () => {
    const res = await postManifest(importerToken).expect(201);
    createdBatchIds.push(res.body.id);
    expect(res.body.createdCount).toBe(0);
    // Row 1 (now exists) + row 2 (pre-existing) are both duplicates; row 3 stays an error.
    expect(res.body.duplicateCount).toBe(2);
    expect(res.body.errorCount).toBe(1);
  }, 60000);

  it('lists import batches (paginated, newest first)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/imports')
      .query({ page: 1, pageSize: 50 })
      .set('Authorization', `Bearer ${importerToken}`)
      .expect(200);
    expect(res.body.total).toBeGreaterThanOrEqual(2);
    const ids = (res.body.items as { id: string }[]).map((b) => b.id);
    expect(ids).toEqual(expect.arrayContaining(createdBatchIds));
  });

  it('bulk-imports a file then de-duplicates it by checksum on a second run', async () => {
    const bulkFile = `bulk-${suffix}.pdf`;
    const bulkPdf = makePdf(`Bulk only ${suffix}`);

    const first = await request(app.getHttpServer())
      .post('/api/imports/bulk')
      .set('Authorization', `Bearer ${importerToken}`)
      .attach('files', bulkPdf, { filename: bulkFile, contentType: 'application/pdf' })
      .expect(201);
    createdBatchIds.push(first.body.id);
    expect(first.body.createdCount).toBe(1);
    expect(first.body.duplicateCount).toBe(0);
    const bulkItem = first.body.items[0] as { documentId: string; title: string };
    expect(bulkItem.title).toBe(`bulk-${suffix}`);
    createdDocIds.push(bulkItem.documentId);

    const second = await request(app.getHttpServer())
      .post('/api/imports/bulk')
      .set('Authorization', `Bearer ${importerToken}`)
      .attach('files', bulkPdf, { filename: bulkFile, contentType: 'application/pdf' })
      .expect(201);
    createdBatchIds.push(second.body.id);
    expect(second.body.createdCount).toBe(0);
    expect(second.body.duplicateCount).toBe(1);
    expect((second.body.items[0] as { message: string }).message).toMatch(/checksum/i);
  }, 60000);
});
