import 'reflect-metadata';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { sign } from 'jsonwebtoken';
import { getMetadataStorage } from 'class-validator';
import request from 'supertest';
import { AuthService } from '../auth/auth.service';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { ApiKeyGuard } from '../api-clients/api-key.guard';
import { ApiClientsService } from '../api-clients/api-clients.service';
import { AuditService } from '../audit/audit.service';
import { DocumentsService } from '../documents/documents.service';
import { MCP_ROUTES } from './mcp.routes';
import { McpService } from './mcp.service';
import { McpGuard } from './mcp.guard';
import { McpController } from './mcp.controller';
import { installMcpBodyParsing } from './mcp.bootstrap';
import { CoverPageService } from '../attestation/cover-page.service';

async function controllers(dir: string, suffix = '.controller.ts'): Promise<any[]> {
  const found: any[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'mcp') continue;
    const file = join(dir, e.name);
    if (e.isDirectory()) found.push(...await controllers(file, suffix));
    else if (e.name.endsWith(suffix)) found.push(...Object.values(await import(file)).filter((v: any) => typeof v === 'function' && v.name.endsWith(suffix === '.controller.ts' ? 'Controller' : 'Dto')));
  }
  return found;
}

describe('NestJS MCP with real SDK, JWT, permissions, validation and file interceptors', () => {
  let app: any;
  let url: string;
  const users: Record<string, any> = {};
  const clients: Record<string, any> = {};
  const secret = 'mcp-test-secret-for-local-signed-jwts';
  const audit = { record: jest.fn().mockResolvedValue('audit-id') };
  const documents = {
    create: jest.fn(async (dto, user) => ({ id: `document-${user.id}`, ...dto, ownerId: user.id })),
    list: jest.fn(async (_query, user) => ({ items: [{ ownerId: user.id }] })),
    get: jest.fn(async (id, user) => ({ id, ownerId: user.id })),
    addVersion: jest.fn(async (_id, file) => ({ id: 'version-id', bytes: file.buffer.toString('base64'), fileName: file.originalname })),
  };
  const configValues: any = { MCP_ENABLED: 'true', JWT_ACCESS_SECRET: secret, MCP_ALLOWED_ORIGINS: 'https://trusted.example.com' };
  const config = { get: (key: string) => configValues[key], getOrThrow: (key: string) => configValues[key] };
  const tokens = (id: string, expiresIn: number = 600) => sign({ sub: id }, secret, { expiresIn });
  const connections: Client[] = [];
  async function connect(headers: Record<string, string>) {
    const client = new Client({ name: 'hermes-compatible-test', version: '1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
    connections.push(client);
    return client;
  }
  beforeAll(async () => {
    const types = await controllers(join(__dirname, '..'));
    const dependencies = new Set(types.flatMap((type) => Reflect.getMetadata('design:paramtypes', type) ?? []));
    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule], controllers: [...types, McpController],
      providers: [
        ...[...dependencies].map((provide) => ({ provide, useValue: {} })),
        { provide: ConfigService, useValue: config },
        { provide: AuthService, useValue: { getAuthUser: jest.fn(async (id) => users[id] ?? null) } },
        { provide: ApiClientsService, useValue: { authenticate: jest.fn(async (key) => clients[key] ?? null) } },
        { provide: AuditService, useValue: audit },
        { provide: DocumentsService, useValue: documents },
        { provide: CoverPageService, useValue: { generateCoverPage: async () => ({ buffer: Buffer.from('%PDF-MCP-export'), fileName: 'cover.pdf' }) } },
        JwtStrategy, JwtAuthGuard, PermissionsGuard, ApiKeyGuard, McpService, McpGuard,
      ],
    }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    installMcpBodyParsing(app);
    app.setGlobalPrefix('api', { exclude: ['health'] });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('Test').setVersion('1').build());
    app.get(McpService).configure(document, () => app.getHttpServer().address().port);
    await app.listen(0, '127.0.0.1');
    url = `${await app.getUrl()}/api/mcp`;
  });
  beforeEach(() => {
    users.alice = { id: 'alice', name: 'Alice', email: 'alice@example.com', roles: [], permissions: ['document.read', 'document.write'], mustChangePassword: false };
    users.bob = { ...users.alice, id: 'bob', permissions: ['document.read'] };
    clients['client.secret'] = { id: 'client', scopes: ['documents:read'], allowedCategoryIds: ['allowed'] };
    audit.record.mockClear(); documents.create.mockClear();
  });
  afterAll(async () => { for (const c of connections) await c.close(); await app?.close(); });

  it('compiles all 107 actual Swagger-backed tools and exposes permission-filtered discovery', async () => {
    expect(app.get(McpService).catalog).toHaveLength(107);
    const client = await connect({ Authorization: `Bearer ${tokens('alice')}` });
    const listed = await client.listTools();
    expect(listed.tools.some((t) => t.name === 'documents_create')).toBe(true);
    expect(listed.tools.some((t) => t.name === 'users_create')).toBe(false);
    expect(listed.tools.some((t) => t.name === 'public_documents_list')).toBe(false);
    expect(listed.tools.some((t) => t.name === 'auth_login')).toBe(false);
    await client.ping();
    expect(app.get(McpService).catalog.find((t: any) => t.name === 'rag_chat_list_conversations').validate({})).toBe(true);
    expect(app.get(McpService).catalog.find((t: any) => t.name === 'storage_admin_list_prefixes').validate({ query: { bucket: 'private-bucket' } })).toBe(true);
  });

  it('calls the original guarded controller and validates its actual DTO', async () => {
    const client = await connect({ Authorization: `Bearer ${tokens('alice')}`, 'User-Agent': 'Hermes-MCP-test' });
    const created = await client.callTool({ name: 'documents_create', arguments: { body: { title: 'Clinic policy' } } });
    expect(created.structuredContent).toMatchObject({ title: 'Clinic policy', ownerId: 'alice' });
    expect(documents.create).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'mcp.tool.called', source: 'api', actorUserId: 'alice', ipAddress: '127.0.0.1', userAgent: 'Hermes-MCP-test' }));
    const before = documents.create.mock.calls.length;
    await expect(client.callTool({ name: 'documents_create', arguments: { body: { title: 'Policy', ownerId: 'bob' } } })).rejects.toThrow();
    const invalid = await client.callTool({ name: 'documents_create', arguments: { body: { title: 'x'.repeat(301) } } });
    expect(invalid.isError).toBe(true);
    expect(invalid.structuredContent).toMatchObject({ status: 400 });
    expect(documents.create.mock.calls).toHaveLength(before);
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('Clinic policy');
  });

  it('describes nullable REST strings as strings rather than reflected Object unions', () => {
    const catalog = (app.get(McpService) as McpService).catalog;
    const validate = (name: string, args: object) => catalog.find((tool) => tool.name === name)!.validate(args);
    expect(validate('documents_update', { path: { id: 'document' }, body: { categoryId: 'category', nextReviewDate: '2026-10-04', effectiveDate: null } })).toBe(true);
    expect(validate('documents_update_review_schedule', { path: { id: 'document' }, body: { reviewCadence: 'quarterly', nextReviewDate: '2026-10-04' } })).toBe(true);
    expect(validate('documents_bulk_review_schedule', { body: { documentIds: ['document'], reviewCadence: 'annual', nextReviewDate: null } })).toBe(true);
    expect(validate('saved_searches_create', { body: { name: 'Clinical', roleName: 'Staff', filters: {}, sort: null } })).toBe(true);
    expect(validate('smtp_update_config', { body: { host: 'localhost', port: 1025, secure: false, username: 'mailer', fromAddress: 'mailer@example.com', fromName: 'Clinic', enabled: false } })).toBe(true);
  });

  it('warns for every one-time API credential result and uses valid Hermes exclusion names', () => {
    const catalog = (app.get(McpService) as McpService).catalog;
    for (const name of ['api_clients_create', 'api_clients_rotate']) {
      expect(catalog.find((tool) => tool.name === name)!.description).toContain('Sensitive inputs/results');
    }
    const guide = readFileSync(join(__dirname, '../../../../docs/admin/mcp-hermes.md'), 'utf8');
    for (const [, name] of guide.matchAll(/^\s+- ([a-z_]+)\s*$/gm)) {
      expect(catalog.some((tool) => tool.name === name)).toBe(true);
    }
  });

  it('includes every validated DTO field in Swagger so strict tools do not discard REST options', async () => {
    const missing: string[] = [];
    for (const type of await controllers(join(__dirname, '..'), '.dto.ts')) {
      const fields: string[] = (Reflect.getMetadata('swagger/apiModelPropertiesArray', type.prototype) ?? []).map((field: string) => field.slice(1));
      const validated = getMetadataStorage().getTargetValidationMetadatas(type, '', false, false);
      for (const field of new Set(validated.map((metadata) => metadata.propertyName))) {
        if (!fields.includes(field)) missing.push(`${type.name}.${field}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('denies manually invoked forbidden tools and rechecks live roles and disabled users', async () => {
    const client = await connect({ Authorization: `Bearer ${tokens('bob')}` });
    expect((await client.callTool({ name: 'documents_create', arguments: { body: { title: 'No' } } })).structuredContent).toMatchObject({ status: 403 });
    users.bob.permissions = ['document.write'];
    expect((await client.listTools()).tools.some((t) => t.name === 'documents_create')).toBe(true);
    delete users.bob;
    await expect(client.listTools()).rejects.toThrow();
    expect(documents.create).not.toHaveBeenCalled();
  });

  it('isolates overlapping users and uploads intact multipart bytes through the real interceptor', async () => {
    const alice = await connect({ Authorization: `Bearer ${tokens('alice')}` });
    const bob = await connect({ Authorization: `Bearer ${tokens('bob')}` });
    const results = await Promise.all([alice.callTool({ name: 'documents_list' }), bob.callTool({ name: 'documents_list' })]);
    expect((results[0].structuredContent as any).items[0].ownerId).toBe('alice');
    expect((results[1].structuredContent as any).items[0].ownerId).toBe('bob');
    const upload = await alice.callTool({ name: 'documents_add_version', arguments: { path: { id: 'document-alice' }, files: { file: { fileName: 'policy.txt', mimeType: 'text/plain', contentBase64: Buffer.from('immutable source').toString('base64') } } } });
    expect(upload.structuredContent).toMatchObject({ bytes: Buffer.from('immutable source').toString('base64'), fileName: 'policy.txt' });
    const bad = await alice.callTool({ name: 'documents_add_version', arguments: { path: { id: 'document-alice' }, files: { file: { fileName: 'bad.exe', mimeType: 'text/plain', contentBase64: 'YQ==' } } } });
    expect(bad.structuredContent).toMatchObject({ status: 400 });
  });

  it('keeps API-key scopes read-only and checks revocation on the next request', async () => {
    const client = await connect({ 'X-Api-Key': 'client.secret' });
    const list = await client.listTools();
    expect(list.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['public_documents_list', 'health_check']));
    expect(list.tools.some((t) => t.name === 'public_documents_content')).toBe(false);
    expect((await client.callTool({ name: 'documents_create', arguments: { body: { title: 'No' } } })).structuredContent).toMatchObject({ status: 403 });
    delete clients['client.secret'];
    await expect(client.listTools()).rejects.toThrow();
  });

  it('delivers complete binary resources through the actual SDK response schema', async () => {
    const client = await connect({ Authorization: `Bearer ${tokens('alice')}` });
    const result = await client.callTool({ name: 'document_signoff_cover_page_pdf', arguments: { path: { id: 'document-alice' } } });
    const resource = (result.content as any[])[0].resource;
    expect(resource.mimeType).toBe('application/pdf');
    expect(Buffer.from(resource.blob, 'base64').toString()).toBe('%PDF-MCP-export');
    expect(result.structuredContent).toMatchObject({ fileName: 'cover.pdf', sizeBytes: 15 });
  });

  it('enforces entry authentication, conflicting credentials, origins and protocol methods', async () => {
    const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    await request(app.getHttpServer()).post('/api/mcp').send(rpc).expect(401);
    await request(app.getHttpServer()).post('/api/mcp').set('Authorization', `Bearer ${tokens('alice', -1)}`).send(rpc).expect(401);
    await request(app.getHttpServer()).post('/api/mcp').set('Authorization', `Bearer ${tokens('alice')}`).set('X-Api-Key', 'client.secret').send(rpc).expect(400);
    await request(app.getHttpServer()).post('/api/mcp').set('Origin', 'https://evil.example.com').set('Authorization', `Bearer ${tokens('alice')}`).send(rpc).expect(403);
    await request(app.getHttpServer()).get('/api/mcp').set('Authorization', `Bearer ${tokens('alice')}`).expect(405);
    await request(app.getHttpServer()).delete('/api/mcp').set('Authorization', `Bearer ${tokens('alice')}`).expect(405);
    expect(MCP_ROUTES.every((r) => r.name.length <= 64)).toBe(true);
  });

  it('gives MCP its own parser without enlarging ordinary REST JSON bodies', async () => {
    const token = tokens('alice');
    await request(app.getHttpServer()).post('/api/documents').set('Authorization', `Bearer ${token}`).send({ title: 'x'.repeat(110000) }).expect(413);
    const result = await request(app.getHttpServer()).post('/api/mcp').set('Authorization', `Bearer ${token}`).set('Accept', 'application/json, text/event-stream').send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'documents_create', arguments: { body: { title: 'x'.repeat(110000) } } } });
    expect(result.status).toBe(200);
    // The MCP parser accepts it; downstream REST still rejects >100 KiB before DTO validation.
    expect(result.body.result.structuredContent.status).toBe(413);
  });

  it('returns no endpoint when disabled and limits overlapping dispatch without replay', async () => {
    const mcp = app.get(McpService);
    mcp.config.enabled = false;
    await request(app.getHttpServer()).post('/api/mcp').send({}).expect(404);
    mcp.config.enabled = true;
    const client = await connect({ Authorization: `Bearer ${tokens('alice')}` });
    mcp.config.maxConcurrentCalls = 1;
    let release!: () => void;
    let started!: () => void;
    const arrived = new Promise<void>((resolve) => { started = resolve; });
    documents.create.mockImplementationOnce(async (dto, user) => { started(); await new Promise<void>((resolve) => { release = resolve; }); return { id: 'created', ...dto, ownerId: user.id }; });
    const first = client.callTool({ name: 'documents_create', arguments: { body: { title: 'One' } } });
    await arrived;
    const second = await client.callTool({ name: 'documents_create', arguments: { body: { title: 'Two' } } });
    expect(second.structuredContent).toMatchObject({ status: 429 });
    release(); await first;
    expect(documents.create).toHaveBeenCalledTimes(1);
    mcp.config.maxConcurrentCalls = 4;
  });
});
