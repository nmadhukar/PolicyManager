import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import request from 'supertest';
import { PERMISSIONS, ROLES } from '@policymanager/shared';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * End-to-end proof of the public read-only API v1 (Phase 7) against the running
 * Postgres + MinIO. Exercises the whole contract:
 *   create client (secret shown once) -> /api/v1/documents with a valid key 200,
 *   bad/no key 401 -> a key WITHOUT content:read gets 403 on /content -> the
 *   visibility filter returns ONLY the published, non-confidential, in-allowed
 *   -category document (draft/archived/confidential/other-category excluded) ->
 *   /content returns extracted text -> /download returns a presigned URL ->
 *   /search finds it by keyword -> every call is audited with source=api ->
 *   revoke -> the same key is now 401. Also asserts there are NO write routes
 *   under /api/v1.
 */
describe('Public API v1 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const suffix = Date.now();
  const adminEmail = `e2e-api-admin-${suffix}@policymanager.local`;
  const password = 'E2e-Pass!123';
  const kw = `seclusion${suffix}`; // unique keyword so search is deterministic

  const createdUserIds: string[] = [];
  const createdDocIds: string[] = [];
  const createdCategoryIds: string[] = [];
  const createdApiClientIds: string[] = [];

  let jwt = '';
  let ownerId = '';
  let allowedCategoryId = '';
  let otherCategoryId = '';
  let publishedDocId = '';

  async function ensureRbac(): Promise<string> {
    const permKeys = [PERMISSIONS.DOCUMENT_READ, PERMISSIONS.DOCUMENT_WRITE, PERMISSIONS.API_MANAGE];
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

  /** Creates a document + a single current version directly (fast, deterministic). */
  async function makeDoc(opts: {
    title: string;
    status: 'draft' | 'published' | 'archived';
    accessLevel: 'public' | 'restricted' | 'confidential';
    categoryId: string;
    extractedText?: string;
  }): Promise<string> {
    const doc = await prisma.document.create({
      data: {
        title: opts.title,
        ownerId,
        categoryId: opts.categoryId,
        status: opts.status,
        accessLevel: opts.accessLevel,
        tags: ['CARF'],
      },
    });
    createdDocIds.push(doc.id);
    const version = await prisma.documentVersion.create({
      data: {
        documentId: doc.id,
        versionNumber: 1,
        s3Key: `documents/${doc.id}/v1/policy.pdf`,
        fileName: 'policy.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1234,
        checksum: 'deadbeef',
        uploadedById: ownerId,
        extractedText: opts.extractedText,
        // Mirror the app write path (writeVersion) which persists this flag
        // alongside the text (D2) — the summary/versions reads use the flag.
        hasExtractedText: !!opts.extractedText && opts.extractedText.length > 0,
      },
    });
    await prisma.document.update({
      where: { id: doc.id },
      data: { currentVersionId: version.id },
    });
    return doc.id;
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
      data: {
        email: adminEmail,
        name: 'API Admin',
        passwordHash,
        roles: { create: { roleId: adminRoleId } },
      },
    });
    createdUserIds.push(user.id);
    ownerId = user.id;

    const allowed = await prisma.documentCategory.create({ data: { name: `Allowed ${suffix}` } });
    const other = await prisma.documentCategory.create({ data: { name: `Other ${suffix}` } });
    allowedCategoryId = allowed.id;
    otherCategoryId = other.id;
    createdCategoryIds.push(allowed.id, other.id);

    // The one document that SHOULD be visible to a client scoped to `allowed`.
    publishedDocId = await makeDoc({
      title: `Visible Policy ${suffix}`,
      status: 'published',
      accessLevel: 'restricted',
      categoryId: allowedCategoryId,
      extractedText: `This ${kw} and restraint policy governs safety.`,
    });
    // Four documents that must all be EXCLUDED.
    await makeDoc({ title: `Draft ${suffix}`, status: 'draft', accessLevel: 'restricted', categoryId: allowedCategoryId, extractedText: kw });
    await makeDoc({ title: `Archived ${suffix}`, status: 'archived', accessLevel: 'restricted', categoryId: allowedCategoryId, extractedText: kw });
    await makeDoc({ title: `Confidential ${suffix}`, status: 'published', accessLevel: 'confidential', categoryId: allowedCategoryId, extractedText: kw });
    await makeDoc({ title: `Other Category ${suffix}`, status: 'published', accessLevel: 'restricted', categoryId: otherCategoryId, extractedText: kw });

    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: adminEmail, password })
      .expect(200);
    jwt = login.body.accessToken;
  }, 45000);

  afterAll(async () => {
    if (prisma) {
      await prisma.auditEvent.deleteMany({ where: { apiClientId: { in: createdApiClientIds } } });
      await prisma.apiClient.deleteMany({ where: { id: { in: createdApiClientIds } } });
      await prisma.document.updateMany({
        where: { id: { in: createdDocIds } },
        data: { currentVersionId: null },
      });
      await prisma.documentVersion.deleteMany({ where: { documentId: { in: createdDocIds } } });
      await prisma.document.deleteMany({ where: { id: { in: createdDocIds } } });
      await prisma.documentCategory.deleteMany({ where: { id: { in: createdCategoryIds } } });
      await prisma.refreshToken.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app?.close();
  });

  const bearer = () => `Bearer ${jwt}`;

  // Credentials minted during the run.
  let fullCredential = ''; // documents:read + content:read + download, scoped to allowed
  let fullClientId = '';
  let noContentCredential = ''; // documents:read only

  it('creates an API client and returns the secret exactly once (never the hash)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/api-clients')
      .set('Authorization', bearer())
      .send({
        name: `EMR ${suffix}`,
        scopes: ['documents:read', 'content:read', 'download'],
        allowedCategoryIds: [allowedCategoryId],
      })
      .expect(201);

    expect(res.body.secret).toBeTruthy();
    expect(res.body.credential).toBe(`${res.body.client.clientId}.${res.body.secret}`);
    // The hash is never exposed.
    expect(JSON.stringify(res.body)).not.toContain('secretHash');
    fullCredential = res.body.credential;
    fullClientId = res.body.client.id;
    createdApiClientIds.push(res.body.client.id);

    // A second, minimally-scoped client (documents:read only) to prove 403 on /content.
    const res2 = await request(app.getHttpServer())
      .post('/api/api-clients')
      .set('Authorization', bearer())
      .send({ name: `NoContent ${suffix}`, scopes: ['documents:read'] })
      .expect(201);
    noContentCredential = res2.body.credential;
    createdApiClientIds.push(res2.body.client.id);

    // The management LIST never leaks a secret/hash.
    const list = await request(app.getHttpServer())
      .get('/api/api-clients')
      .set('Authorization', bearer())
      .expect(200);
    expect(JSON.stringify(list.body)).not.toContain('secretHash');
    expect(JSON.stringify(list.body)).not.toContain(res.body.secret);
  });

  it('rejects the public API without a key (401) and with a bad key (401)', async () => {
    await request(app.getHttpServer()).get('/api/v1/documents').expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/documents')
      .set('Authorization', 'Bearer pmk_nope.wrong')
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/documents')
      .set('X-Api-Key', 'garbage-no-dot')
      .expect(401);
  });

  it('lists ONLY the published, non-confidential, in-allowed-category document', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/documents')
      .set('Authorization', `Bearer ${fullCredential}`)
      .query({ pageSize: 100 })
      .expect(200);

    const ids = (res.body.items as { id: string }[]).map((d) => d.id);
    expect(ids).toContain(publishedDocId);
    // Exactly one of OUR documents is visible (the others are excluded).
    const mine = (res.body.items as { id: string }[]).filter((d) => createdDocIds.includes(d.id));
    expect(mine).toHaveLength(1);
    const visible = (res.body.items as { accessLevel: string; status: string }[]).find(
      (d) => (d as unknown as { id: string }).id === publishedDocId,
    );
    expect(visible?.status).toBe('published');
    expect(visible?.accessLevel).not.toBe('confidential');
  });

  it('also accepts the key via X-Api-Key', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/documents')
      .set('X-Api-Key', fullCredential)
      .expect(200);
  });

  it('403s /content for a key without content:read; returns extracted text with it', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/documents/${publishedDocId}/content`)
      .set('Authorization', `Bearer ${noContentCredential}`)
      .expect(403);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/documents/${publishedDocId}/content`)
      .set('Authorization', `Bearer ${fullCredential}`)
      .expect(200);
    expect(res.body.hasExtractedText).toBe(true);
    expect(res.body.extractedText).toContain(kw);
  });

  it('gets a single visible document through the public detail route', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/documents/${publishedDocId}`)
      .set('Authorization', `Bearer ${fullCredential}`)
      .expect(200);
    expect(res.body).toMatchObject({ id: publishedDocId, status: 'published', version: 1 });
    expect(res.body.accessLevel).not.toBe('confidential');
  });

  it('404s a confidential/hidden document through the public detail route', async () => {
    // Grab the confidential doc id (created but never exposed).
    const confidential = await prisma.document.findFirst({
      where: { ownerId, accessLevel: 'confidential' },
      select: { id: true },
    });
    await request(app.getHttpServer())
      .get(`/api/v1/documents/${confidential?.id}`)
      .set('Authorization', `Bearer ${fullCredential}`)
      .expect(404);
  });

  it('returns a short-lived presigned download URL (scope download)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/documents/${publishedDocId}/download`)
      .set('Authorization', `Bearer ${fullCredential}`)
      .expect(200);
    expect(res.body.url).toMatch(/^https?:\/\//);
    expect(res.body.expiresIn).toBeGreaterThan(0);
    expect(res.body.expiresIn).toBeLessThanOrEqual(300);
    expect(res.body.fileName).toBe('policy.pdf');
  });

  it('lists version metadata for a visible document', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/documents/${publishedDocId}/versions`)
      .set('Authorization', `Bearer ${fullCredential}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toMatchObject({ version: 1, fileName: 'policy.pdf', hasExtractedText: true });
  });

  it('finds the document by keyword search (and excludes hidden ones)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/search')
      .set('Authorization', `Bearer ${fullCredential}`)
      .query({ q: kw, pageSize: 100 })
      .expect(200);
    const ids = (res.body.items as { document: { id: string } }[]).map((h) => h.document.id);
    expect(ids).toContain(publishedDocId);
    // Only our one visible doc matches (draft/archived/confidential/other excluded).
    const mine = ids.filter((id) => createdDocIds.includes(id));
    expect(mine).toEqual([publishedDocId]);
    expect(res.body.items[0]).toHaveProperty('score');
    expect(res.body.items[0]).toHaveProperty('snippet');
  });

  it('has NO write routes under /api/v1 (read-only surface)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/documents')
      .set('Authorization', `Bearer ${fullCredential}`)
      .send({ title: 'nope' })
      .expect(404);
    await request(app.getHttpServer())
      .delete(`/api/v1/documents/${publishedDocId}`)
      .set('Authorization', `Bearer ${fullCredential}`)
      .expect(404);
  });

  it('audits every public call with source=api and the apiClientId', async () => {
    const events = await prisma.auditEvent.findMany({
      where: { apiClientId: fullClientId },
      select: { action: true, source: true },
    });
    const actions = Array.from(new Set(events.map((e) => e.action)));
    // Every audited row is source=api.
    expect(events.every((e) => e.source === 'api')).toBe(true);
    // The calls above each left a trail.
    expect(actions).toEqual(
      expect.arrayContaining([
        'api.documents.listed',
        'api.document.read',
        'api.content.read',
        'api.download.issued',
        'api.versions.read',
        'api.search',
      ]),
    );
  });

  it('revokes the client, after which the same key is rejected (401)', async () => {
    await request(app.getHttpServer())
      .post(`/api/api-clients/${fullClientId}/revoke`)
      .set('Authorization', bearer())
      .expect(200);

    await request(app.getHttpServer())
      .get('/api/v1/documents')
      .set('Authorization', `Bearer ${fullCredential}`)
      .expect(401);
  });
});
