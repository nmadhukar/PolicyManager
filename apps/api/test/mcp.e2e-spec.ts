import { createHash } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as argon2 from 'argon2';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import JSZip from 'jszip';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { McpService } from '../src/mcp/mcp.service';
import { installMcpBodyParsing } from '../src/mcp/mcp.bootstrap';

/** Actual services, PostgreSQL and private S3. No business-service mocks.
 * Run only against disposable test infrastructure; cleanup removes only this
 * suite's fixture rows. PDF source uploads need no conversion service.
 */
describe('MCP document workflows (live PostgreSQL + S3)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let endpoint: URL;
  const clients: Client[] = [];
  const users: string[] = [];
  const roles: string[] = [];
  const documents: string[] = [];
  const apiClients: string[] = [];
  const categories: string[] = [];
  const batches: string[] = [];
  const suffix = `${Date.now()}-${process.pid}`;
  let admin: Client;
  let staff: Client;
  let reviewer: Client;
  let reviewerId: string;
  let staffId: string;
  let documentId: string;
  let versionId: string;
  let source: Buffer;

  async function connect(headers: Record<string, string>): Promise<Client> {
    const client = new Client({ name: 'policymanager-live-acceptance', version: '1.0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers } }));
    return client;
  }

  async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.structuredContent)}`);
    return result.structuredContent;
  }

  async function makeUser(name: string, keys: string[]): Promise<{ id: string; token: string }> {
    const permissions = await Promise.all(keys.map((key) => prisma.permission.upsert({ where: { key }, update: {}, create: { key } })));
    const role = await prisma.role.create({ data: { name: `mcp-${name}-${suffix}`, permissions: { create: permissions.map((permission) => ({ permissionId: permission.id })) } } });
    roles.push(role.id);
    const email = `mcp-${name}-${suffix}@policymanager.local`;
    const password = 'Mcp-Test!Pass123';
    const user = await prisma.user.create({ data: { email, name, passwordHash: await argon2.hash(password), roles: { create: { roleId: role.id } } } });
    users.push(user.id);
    // Bootstrap remains outside model tools, exactly as a bot credential broker would do.
    const login = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password }).expect(200);
    return { id: user.id, token: login.body.accessToken };
  }

  beforeAll(async () => {
    if (process.env.MCP_ENABLED !== 'true') throw new Error('MCP e2e requires MCP_ENABLED=true and disposable PostgreSQL/S3');
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication({ bodyParser: false });
    installMcpBodyParsing(app);
    app.setGlobalPrefix('api', { exclude: ['health'] });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.init();
    app.get(McpService).configure(SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('MCP acceptance').setVersion('1').build()), () => app.getHttpServer().address().port);
    await app.listen(0, '127.0.0.1');
    endpoint = new URL(`http://127.0.0.1:${app.getHttpServer().address().port}/api/mcp`);
    prisma = app.get(PrismaService);
    const adminUser = await makeUser('manager', ['document.read', 'document.write', 'document.approve', 'review.manage', 'api.manage', 'audit.read', 'evidence.export']);
    const staffUser = await makeUser('staff', ['document.read']);
    const reviewerUser = await makeUser('reviewer', ['document.read']);
    reviewerId = reviewerUser.id;
    staffId = staffUser.id;
    admin = await connect({ Authorization: `Bearer ${adminUser.token}`, 'User-Agent': 'Hermes-live-test' });
    staff = await connect({ Authorization: `Bearer ${staffUser.token}` });
    reviewer = await connect({ Authorization: `Bearer ${reviewerUser.token}` });
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage().drawText('MCP immutable clinical policy', { x: 30, y: 300, font, size: 14 });
    source = Buffer.from(await pdf.save({ useObjectStreams: false }));
  }, 60000);

  afterAll(async () => {
    for (const client of clients) await client.close();
    if (prisma) {
      // Normal application paths remain immutable/soft-delete only. Test fixture
      // teardown is isolated and privileged, never exposed as an MCP tool.
      await prisma.attestation.deleteMany({ where: { documentId: { in: documents } } });
      await prisma.acknowledgmentAssignment.deleteMany({ where: { documentId: { in: documents } } });
      await prisma.reviewTask.deleteMany({ where: { documentId: { in: documents } } });
      await prisma.reviewAssignment.deleteMany({ where: { documentId: { in: documents } } });
      await prisma.notificationLog.deleteMany({ where: { toEmail: { contains: suffix } } });
      await prisma.notification.deleteMany({ where: { recipientId: { in: users } } });
      await prisma.auditEvent.deleteMany({ where: { OR: [{ actorUserId: { in: users } }, { apiClientId: { in: apiClients } }, { documentId: { in: documents } }] } });
      await prisma.apiClient.deleteMany({ where: { id: { in: apiClients } } });
      await prisma.evidenceBinderJob.deleteMany({ where: { documentId: { in: documents } } });
      await prisma.importBatch.deleteMany({ where: { id: { in: batches } } });
      await prisma.document.updateMany({ where: { id: { in: documents } }, data: { currentVersionId: null } });
      await prisma.documentVersion.deleteMany({ where: { documentId: { in: documents } } });
      await prisma.document.deleteMany({ where: { id: { in: documents } } });
      await prisma.documentCategory.deleteMany({ where: { id: { in: categories } } });
      await prisma.refreshToken.deleteMany({ where: { userId: { in: users } } });
      await prisma.userRole.deleteMany({ where: { userId: { in: users } } });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
      await prisma.rolePermission.deleteMany({ where: { roleId: { in: roles } } });
      await prisma.role.deleteMany({ where: { id: { in: roles } } });
    }
    await app?.close();
  }, 60000);

  it('creates and uploads immutable bytes, reads private storage, and preserves RBAC', async () => {
    const created = await call(admin, 'documents_create', { body: { title: `MCP clinical policy ${suffix}`, reviewCadence: 'quarterly' } });
    documentId = created.id;
    documents.push(documentId);
    const version = await call(admin, 'documents_add_version', { path: { id: documentId }, files: { file: { fileName: 'policy.pdf', mimeType: 'application/pdf', contentBase64: source.toString('base64') } } });
    versionId = version.id;
    expect(version.checksum).toBe(createHash('sha256').update(source).digest('hex'));
    const downloaded = await call(admin, 'documents_download', { path: { id: documentId, versionId } });
    const response = await fetch(downloaded.url);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(source);
    expect((await staff.callTool({ name: 'documents_soft_delete', arguments: { path: { id: documentId } } })).structuredContent).toMatchObject({ status: 403 });
    expect((await call(admin, 'documents_get', { path: { id: documentId } })).currentVersion.id).toBe(versionId);
  });

  it('reviews, publishes, exports valid PDF and requires viewed evidence before acknowledgment', async () => {
    await call(admin, 'documents_update_review_schedule', { path: { id: documentId }, body: { reviewCadence: 'quarterly', nextReviewDate: new Date(Date.now() - 86400000).toISOString() } });
    await call(admin, 'reviewers_assign', { path: { id: documentId }, body: { reviewerId } });
    const review = await prisma.reviewTask.findFirstOrThrow({ where: { documentId, assignedToId: reviewerId } });
    expect((await staff.callTool({ name: 'reviews_complete', arguments: { path: { taskId: review.id }, body: {} } })).structuredContent).toMatchObject({ status: 403 });
    expect((await reviewer.callTool({ name: 'reviews_complete', arguments: { path: { taskId: review.id }, body: {} } })).structuredContent).toMatchObject({ status: 400 });
    const reviewed = await call(reviewer, 'documents_view_url', { path: { id: documentId, versionId } });
    expect((await fetch(reviewed.url)).status).toBe(200);
    await call(reviewer, 'reviews_complete', { path: { taskId: review.id }, body: { notes: 'Reviewed from MCP' } });
    await call(admin, 'document_signoff_approve', { path: { id: documentId }, body: { publish: true } });
    const exported = await admin.callTool({ name: 'document_signoff_export_pdf', arguments: { path: { id: documentId } } });
    expect(exported.isError).not.toBe(true);
    const resource = (exported.content as any[])[0].resource;
    expect((await PDFDocument.load(Buffer.from(resource.blob, 'base64'))).getPageCount()).toBe(2);
    await call(admin, 'document_signoff_distribute', { path: { id: documentId }, body: { assigneeIds: [staffId] } });
    const assignment = await prisma.acknowledgmentAssignment.findFirstOrThrow({ where: { documentId, assigneeId: staffId } });
    expect((await staff.callTool({ name: 'acknowledgments_acknowledge', arguments: { path: { id: assignment.id }, body: { hasViewed: true } } })).structuredContent).toMatchObject({ status: 400 });
    const view = await call(staff, 'documents_view_url', { path: { id: documentId, versionId } });
    expect((await fetch(view.url)).status).toBe(200);
    await call(staff, 'acknowledgments_acknowledge', { path: { id: assignment.id }, body: { hasViewed: true } });
    expect((await prisma.attestation.findMany({ where: { documentId } })).map((row) => row.action)).toEqual(expect.arrayContaining(['reviewed', 'approved', 'acknowledged']));
    const events = await prisma.auditEvent.findMany({ where: { action: 'mcp.tool.called', actorUserId: { in: users } } });
    expect(events.some((event) => event.userAgent === 'Hermes-live-test' && event.ipAddress === '127.0.0.1')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('Reviewed from MCP');
  });

  it('imports manifest, folder-relative bulk and ZIP bytes, and exports an intact evidence ZIP', async () => {
    const encode = (fileName: string, mimeType: string, bytes: Buffer) => ({ fileName, mimeType, contentBase64: bytes.toString('base64') });
    const verifyImport = async (batch: any, bytes: Buffer) => {
      batches.push(batch.id);
      for (const item of batch.items) if (item.documentId && !documents.includes(item.documentId)) documents.push(item.documentId);
      expect(batch).toMatchObject({ createdCount: 1, errorCount: 0, status: 'completed' });
      const imported = await prisma.document.findUniqueOrThrow({ where: { id: batch.items[0].documentId }, include: { currentVersion: true } });
      if (imported.categoryId && !categories.includes(imported.categoryId)) categories.push(imported.categoryId);
      expect(imported.currentVersion!.checksum).toBe(createHash('sha256').update(bytes).digest('hex'));
      const ticket = await call(admin, 'documents_download', { path: { id: imported.id, versionId: imported.currentVersion!.id } });
      expect(Buffer.from(await (await fetch(ticket.url)).arrayBuffer())).toEqual(bytes);
    };
    const manifestBytes = Buffer.concat([source, Buffer.from(`\n% manifest ${suffix}`)]);
    const csv = Buffer.from(`fileName,title\nmanifest.pdf,MCP imported ${suffix}\n`);
    await verifyImport(await call(admin, 'imports_import_manifest', { files: { manifest: encode('manifest.csv', 'text/csv', csv), files: [encode('manifest.pdf', 'application/pdf', manifestBytes)] } }), manifestBytes);
    const bulkBytes = Buffer.concat([source, Buffer.from(`\n% bulk ${suffix}`)]);
    await verifyImport(await call(admin, 'imports_import_bulk', { files: { files: [encode('bulk.pdf', 'application/pdf', bulkBytes)] }, body: { relativePaths: [`MCP-bulk-${suffix}/bulk.pdf`] } }), bulkBytes);
    const packedBytes = Buffer.concat([source, Buffer.from(`\n% packed ${suffix}`)]);
    const archive = new JSZip();
    archive.file(`MCP-zip-${suffix}/packed.pdf`, packedBytes);
    const packed = await archive.generateAsync({ type: 'nodebuffer' });
    await verifyImport(await call(admin, 'imports_import_bulk', { files: { files: [encode('policies.zip', 'application/zip', packed)] } }), packedBytes);
    const otherUser = await makeUser('other-importer', ['document.read', 'document.write']);
    const other = await connect({ Authorization: `Bearer ${otherUser.token}` });
    expect((await other.callTool({ name: 'imports_get', arguments: { path: { id: batches[0] } } })).structuredContent).toMatchObject({ status: 404 });
    const result = await admin.callTool({ name: 'evidence_binder_export', arguments: { path: { id: documentId }, body: { format: 'zip', includeAuditLog: false } } });
    expect(result.isError).not.toBe(true);
    const resource = (result.content as any[])[0].resource;
    expect(resource.mimeType).toBe('application/zip');
    const zipBytes = Buffer.from(resource.blob, 'base64');
    const zip = await JSZip.loadAsync(zipBytes);
    expect(zip.file('manifest.json')).not.toBeNull();
    expect((await PDFDocument.load(await zip.file('policy-with-cover.pdf')!.async('nodebuffer'))).getPageCount()).toBe(2);
    const job = await prisma.evidenceBinderJob.findFirstOrThrow({ where: { documentId } });
    expect(job.checksum).toBe(createHash('sha256').update(zipBytes).digest('hex'));
  });

  it('limits API credentials to published v1 reads and applies revocation immediately', async () => {
    const category = await call(admin, 'document_categories_create', { body: { name: `MCP category ${suffix}` } });
    categories.push(category.id);
    await call(admin, 'documents_update', { path: { id: documentId }, body: { categoryId: category.id } });
    const credential = await call(admin, 'api_clients_create', { body: { name: `MCP reader ${suffix}`, scopes: ['documents:read', 'content:read', 'download'], allowedCategoryIds: [category.id] } });
    apiClients.push(credential.client.id);
    const reader = await connect({ 'X-Api-Key': credential.credential });
    expect((await reader.listTools()).tools).toHaveLength(7);
    expect((await call(reader, 'public_documents_get', { path: { id: documentId } })).id).toBe(documentId);
    expect((await call(reader, 'public_documents_list')).items.map((item: any) => item.id)).toContain(documentId);
    expect((await call(reader, 'public_documents_search', { query: { q: 'MCP clinical policy' } })).items.some((item: any) => item.document.id === documentId)).toBe(true);
    expect(await call(reader, 'public_documents_content', { path: { id: documentId } })).toMatchObject({ documentId, versionId });
    expect((await call(reader, 'public_documents_versions', { path: { id: documentId } })).value).toHaveLength(1);
    const download = await call(reader, 'public_documents_download', { path: { id: documentId } });
    expect(Buffer.from(await (await fetch(download.url)).arrayBuffer())).toEqual(source);
    // Real public visibility checks, not just tool filtering, govern every read.
    for (const variant of ['draft', 'confidential', 'outside-category', 'deleted']) {
      const hidden = await call(admin, 'documents_create', { body: { title: `Hidden ${variant} ${suffix}`, ...(variant !== 'outside-category' ? { categoryId: category.id } : {}), ...(variant === 'confidential' ? { accessLevel: 'confidential' } : {}) } });
      documents.push(hidden.id);
      if (variant !== 'draft') await call(admin, 'documents_update', { path: { id: hidden.id }, body: { status: 'published' } });
      if (variant === 'deleted') await call(admin, 'documents_soft_delete', { path: { id: hidden.id } });
      if (variant === 'confidential') expect((await staff.callTool({ name: 'documents_get', arguments: { path: { id: hidden.id } } })).structuredContent).toMatchObject({ status: 403 });
      expect((await reader.callTool({ name: 'public_documents_get', arguments: { path: { id: hidden.id } } })).structuredContent).toMatchObject({ status: 404 });
    }
    expect((await reader.callTool({ name: 'documents_create', arguments: { body: { title: 'Forbidden' } } })).structuredContent).toMatchObject({ status: 403 });
    await call(admin, 'api_clients_revoke', { path: { id: credential.client.id } });
    await expect(reader.listTools()).rejects.toThrow();
  });

  it('restores into a new immutable version and soft-deletes/restores without losing history', async () => {
    await call(admin, 'documents_restore_version', { path: { id: documentId, versionId } });
    const versions = await prisma.documentVersion.findMany({ where: { documentId }, orderBy: { versionNumber: 'asc' } });
    expect(versions).toHaveLength(2);
    expect(versions[1].checksum).toBe(versions[0].checksum);
    expect(versions[1].s3Key).not.toBe(versions[0].s3Key);
    await call(admin, 'documents_soft_delete', { path: { id: documentId } });
    expect((await prisma.document.findUniqueOrThrow({ where: { id: documentId } })).deletedAt).not.toBeNull();
    expect(await prisma.documentVersion.count({ where: { documentId } })).toBe(2);
    await call(admin, 'documents_restore', { path: { id: documentId } });
    expect((await prisma.document.findUniqueOrThrow({ where: { id: documentId } })).deletedAt).toBeNull();
    const tables = await prisma.$queryRaw<{ table_schema: string; table_name: string }[]>`select table_schema, table_name from information_schema.tables where table_schema in ('public', 'policytracker') order by table_schema, table_name`;
    expect(tables.length).toBeGreaterThan(0);
    expect(tables.every((table) => table.table_schema === 'policytracker')).toBe(true);
  });
});
