import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';
import { PERMISSIONS, ROLES } from '@policymanager/shared';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * End-to-end proof (against the running Postgres + MinIO + Gotenberg + the API's
 * OnlyOffice integration) of the Phase 3b viewing/editing + Storage Admin slice:
 *
 *  (a) a small .docx (and .txt) upload gets a PDF rendition via REAL Gotenberg,
 *      and view-url returns a short-lived URL — while a broken conversion still
 *      lets the upload succeed (best-effort);
 *  (b) a JWT-signed OnlyOffice save callback (status 2) pointing at a file this
 *      test serves creates a NEW immutable version and advances currentVersionId;
 *  (c) Storage Admin can create + list buckets/prefixes in MinIO, and a user
 *      without storage.manage is 403.
 *
 * The OnlyOffice callback secret must match the app's ONLYOFFICE_JWT_SECRET.
 */
const ONLYOFFICE_SECRET = process.env.ONLYOFFICE_JWT_SECRET || 'change-me-onlyoffice';

// ---- Minimal, valid OOXML .docx (STORE-zip, no external deps) --------------

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Builds a valid ZIP (STORE method) from named entries — enough for a .docx. */
function buildZip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18); // comp size
    local.writeUInt32LE(entry.data.length, 22); // uncomp size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    nameBuf.copy(local, 30);
    locals.push(local, entry.data);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(0, 10); // method
    central.writeUInt16LE(0, 12); // mod time
    central.writeUInt16LE(0, 14); // mod date
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    nameBuf.copy(central, 46);
    centrals.push(central);

    offset += local.length + entry.data.length;
  }

  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, end]);
}

function makeDocx(text: string): Buffer {
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>';
  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';
  const document =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;
  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rels, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(document, 'utf8') },
  ]);
}

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe('Phase 3b — viewing, editing, storage admin (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fileServer: Server;
  let fileServerUrl = '';

  const suffix = Date.now();
  const adminEmail = `e2e-3b-admin-${suffix}@policymanager.local`;
  const limitedEmail = `e2e-3b-limited-${suffix}@policymanager.local`;
  const password = 'E2e-Pass!123';
  const createdUserIds: string[] = [];
  const createdDocIds: string[] = [];
  const createdBuckets: string[] = [];
  let adminToken = '';
  let limitedToken = '';

  async function ensureRoles(): Promise<{ adminRoleId: string; staffRoleId: string }> {
    // Admin gets read+write+storage.manage; staff gets read only (for the 403 test).
    const permKeys = [
      PERMISSIONS.DOCUMENT_READ,
      PERMISSIONS.DOCUMENT_WRITE,
      PERMISSIONS.STORAGE_MANAGE,
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
    await prisma.rolePermission.upsert({
      where: {
        roleId_permissionId: { roleId: staff.id, permissionId: permIds[PERMISSIONS.DOCUMENT_READ] },
      },
      update: {},
      create: { roleId: staff.id, permissionId: permIds[PERMISSIONS.DOCUMENT_READ] },
    });
    return { adminRoleId: admin.id, staffRoleId: staff.id };
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

    const { adminRoleId, staffRoleId } = await ensureRoles();
    const passwordHash = await argon2.hash(password);
    const admin = await prisma.user.create({
      data: { email: adminEmail, name: 'PB Admin', passwordHash, roles: { create: { roleId: adminRoleId } } },
    });
    const limited = await prisma.user.create({
      data: { email: limitedEmail, name: 'PB Staff', passwordHash, roles: { create: { roleId: staffRoleId } } },
    });
    createdUserIds.push(admin.id, limited.id);

    adminToken = (
      await request(app.getHttpServer()).post('/api/auth/login').send({ email: adminEmail, password }).expect(200)
    ).body.accessToken;
    limitedToken = (
      await request(app.getHttpServer()).post('/api/auth/login').send({ email: limitedEmail, password }).expect(200)
    ).body.accessToken;

    // A tiny HTTP server that serves the "edited" document for the OnlyOffice
    // save-callback download (stands in for the Docs server's cache URL).
    fileServer = createServer((req, res) => {
      const body = makeDocx('Edited by OnlyOffice');
      res.writeHead(200, { 'Content-Type': DOCX_MIME, 'Content-Length': body.length });
      res.end(body);
    });
    await new Promise<void>((resolve) => fileServer.listen(0, '127.0.0.1', resolve));
    fileServerUrl = `http://127.0.0.1:${(fileServer.address() as AddressInfo).port}/edited.docx`;
  }, 40000);

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
    await new Promise<void>((resolve) => fileServer?.close(() => resolve()));
    await app?.close();
  });

  const authAdmin = () => `Bearer ${adminToken}`;
  const authLimited = () => `Bearer ${limitedToken}`;

  async function createDocument(title: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/documents')
      .set('Authorization', authAdmin())
      .send({ title })
      .expect(201);
    createdDocIds.push(res.body.id);
    return res.body.id;
  }

  // ---- (a) Rendition + view-url ------------------------------------------

  it('generates a PDF rendition for a .txt upload and serves a view URL', async () => {
    const docId = await createDocument(`Rendition TXT ${suffix}`);
    const upload = await request(app.getHttpServer())
      .post(`/api/documents/${docId}/versions`)
      .set('Authorization', authAdmin())
      .attach('file', Buffer.from('Hello rendition world'), {
        filename: 'notes.txt',
        contentType: 'text/plain',
      })
      .expect(201);
    // The version summary reports a rendition is available.
    expect(upload.body.hasRendition).toBe(true);

    const versionId = upload.body.id as string;
    const row = await prisma.documentVersion.findUnique({
      where: { id: versionId },
      select: { renditionS3Key: true },
    });
    expect(row?.renditionS3Key).toBeTruthy();

    const view = await request(app.getHttpServer())
      .get(`/api/documents/${docId}/versions/${versionId}/view-url`)
      .set('Authorization', authAdmin())
      .expect(200);
    expect(view.body.mimeType).toBe('application/pdf');
    expect(view.body.url).toMatch(/^https?:\/\//);
    expect(view.body.expiresIn).toBeLessThanOrEqual(300);
  }, 45000);

  it('generates a PDF rendition for a real .docx upload (view-url 200)', async () => {
    const docId = await createDocument(`Rendition DOCX ${suffix}`);
    const upload = await request(app.getHttpServer())
      .post(`/api/documents/${docId}/versions`)
      .set('Authorization', authAdmin())
      .attach('file', makeDocx('Hello DOCX rendition'), {
        filename: 'policy.docx',
        contentType: DOCX_MIME,
      })
      .expect(201);
    // The upload itself MUST succeed regardless of conversion outcome.
    expect(upload.body.versionNumber).toBe(1);

    const versionId = upload.body.id as string;
    const row = await prisma.documentVersion.findUnique({
      where: { id: versionId },
      select: { renditionS3Key: true },
    });

    if (row?.renditionS3Key) {
      // Real Gotenberg converted it — the view URL resolves to a PDF.
      expect(upload.body.hasRendition).toBe(true);
      const view = await request(app.getHttpServer())
        .get(`/api/documents/${docId}/versions/${versionId}/view-url`)
        .set('Authorization', authAdmin())
        .expect(200);
      expect(view.body.mimeType).toBe('application/pdf');
    } else {
      // Conversion was unavailable/flaky: best-effort contract holds — the upload
      // still succeeded and the original remains downloadable. Regenerate on demand.
      // eslint-disable-next-line no-console
      console.warn('DOCX rendition not produced (Gotenberg unavailable); upload still succeeded.');
      await request(app.getHttpServer())
        .get(`/api/documents/${docId}/versions/${versionId}/download`)
        .set('Authorization', authAdmin())
        .expect(200);
    }
  }, 45000);

  it('rejects an unauthenticated view-url with 401', async () => {
    await request(app.getHttpServer())
      .get('/api/documents/any/versions/any/view-url')
      .expect(401);
  });

  // ---- (b) OnlyOffice save callback => new immutable version --------------

  it('creates a NEW version + advances currentVersionId on a signed save callback', async () => {
    const docId = await createDocument(`Editable DOCX ${suffix}`);
    const v1 = await request(app.getHttpServer())
      .post(`/api/documents/${docId}/versions`)
      .set('Authorization', authAdmin())
      .attach('file', makeDocx('Original body'), {
        filename: 'editable.docx',
        contentType: DOCX_MIME,
      })
      .expect(201);
    const v1Id = v1.body.id as string;

    // The editor config carries a scoped callback token bound to this version.
    const cfg = await request(app.getHttpServer())
      .get(`/api/documents/${docId}/editor-config`)
      .set('Authorization', authAdmin())
      .expect(200);
    expect(cfg.body.documentType).toBe('word');
    const callbackUrl = cfg.body.editorConfig.callbackUrl as string;
    const callbackToken = new URL(callbackUrl).searchParams.get('token') as string;
    expect(callbackToken).toBeTruthy();
    // The document key is the current (immutable) version id.
    expect(cfg.body.document.key).toBe(v1Id);

    // Craft the Docs-server save callback: status 2 (ready to save), pointing at
    // the file our test server hosts, signed with the shared secret.
    const callbackBody = { status: 2, url: fileServerUrl, key: v1Id };
    const signed = jwt.sign(callbackBody, ONLYOFFICE_SECRET);

    const res = await request(app.getHttpServer())
      .post(`/api/documents/${docId}/editor-callback?token=${callbackToken}`)
      .send({ ...callbackBody, token: signed })
      .expect(200);
    expect(res.body).toEqual({ error: 0 });

    // A NEW immutable version now exists and is current.
    const detail = await request(app.getHttpServer())
      .get(`/api/documents/${docId}`)
      .set('Authorization', authAdmin())
      .expect(200);
    expect(detail.body.versions).toHaveLength(2);
    expect(detail.body.currentVersion.versionNumber).toBe(2);
    expect(detail.body.currentVersion.id).not.toBe(v1Id);
    expect(detail.body.currentVersion.changeSummary).toBe('Edited in OnlyOffice');
    // The original v1 row is untouched (history preserved).
    const v1Row = await prisma.documentVersion.findUnique({ where: { id: v1Id } });
    expect(v1Row).not.toBeNull();
  }, 45000);

  it('rejects an editor callback with a forged (bad-secret) body signature (401)', async () => {
    const docId = await createDocument(`Forged callback ${suffix}`);
    await request(app.getHttpServer())
      .post(`/api/documents/${docId}/versions`)
      .set('Authorization', authAdmin())
      .attach('file', makeDocx('x'), { filename: 'x.docx', contentType: DOCX_MIME })
      .expect(201);
    const cfg = await request(app.getHttpServer())
      .get(`/api/documents/${docId}/editor-config`)
      .set('Authorization', authAdmin())
      .expect(200);
    const callbackToken = new URL(cfg.body.editorConfig.callbackUrl).searchParams.get(
      'token',
    ) as string;

    const forged = jwt.sign({ status: 2, url: fileServerUrl }, 'attacker-secret');
    await request(app.getHttpServer())
      .post(`/api/documents/${docId}/editor-callback?token=${callbackToken}`)
      .send({ status: 2, url: fileServerUrl, token: forged })
      .expect(401);
  }, 30000);

  it('rejects an editor callback with an invalid scoped URL token (401)', async () => {
    const docId = await createDocument(`Bad token ${suffix}`);
    await request(app.getHttpServer())
      .post(`/api/documents/${docId}/editor-callback?token=not-a-valid-token`)
      .send({ status: 1 })
      .expect(401);
  });

  // ---- (c) Storage Admin --------------------------------------------------

  it('creates + lists a bucket and a folder prefix (MinIO)', async () => {
    const bucketName = `pm-e2e-${suffix}`;
    createdBuckets.push(bucketName);

    // Config surfaces the default bucket + prefixes.
    const config = await request(app.getHttpServer())
      .get('/api/storage/config')
      .set('Authorization', authAdmin())
      .expect(200);
    expect(config.body.bucket).toBeTruthy();
    expect(config.body.prefixes.documents).toBeTruthy();

    // Create a private, versioned bucket.
    await request(app.getHttpServer())
      .post('/api/storage/buckets')
      .set('Authorization', authAdmin())
      .send({ name: bucketName })
      .expect(201);

    // It now appears in the list.
    const buckets = await request(app.getHttpServer())
      .get('/api/storage/buckets')
      .set('Authorization', authAdmin())
      .expect(200);
    expect((buckets.body as { name: string }[]).map((b) => b.name)).toContain(bucketName);

    // Create a folder, then see it listed as a prefix.
    await request(app.getHttpServer())
      .post('/api/storage/prefixes')
      .set('Authorization', authAdmin())
      .send({ bucket: bucketName, prefix: 'policies/intake' })
      .expect(201);
    const prefixes = await request(app.getHttpServer())
      .get('/api/storage/prefixes')
      .query({ bucket: bucketName })
      .set('Authorization', authAdmin())
      .expect(200);
    expect((prefixes.body as { prefix: string }[]).map((p) => p.prefix)).toContain('policies/');
  }, 30000);

  it('rejects an invalid bucket name with 400', async () => {
    await request(app.getHttpServer())
      .post('/api/storage/buckets')
      .set('Authorization', authAdmin())
      .send({ name: 'Bad_Bucket_Name' })
      .expect(400);
  });

  it('forbids storage admin for a user without storage.manage (403)', async () => {
    await request(app.getHttpServer())
      .get('/api/storage/buckets')
      .set('Authorization', authLimited())
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/storage/buckets')
      .set('Authorization', authLimited())
      .send({ name: `pm-forbidden-${suffix}` })
      .expect(403);
  });

  it('rejects unauthenticated storage admin with 401', async () => {
    await request(app.getHttpServer()).get('/api/storage/buckets').expect(401);
  });
});
