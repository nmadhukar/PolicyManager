import { createServer, type Server } from 'http';
import { readMcpConfig } from './mcp.config';
import { buildMultipart } from './mcp.files';
import { dispatchTool, buildToolUrl } from './mcp.dispatch';
import { MCP_ROUTES } from './mcp.routes';

const limits = readMcpConfig({ get: (key: string) => ({ MCP_ENABLED: 'true' } as any)[key] } as any);
const identity = { kind: 'user' as const, credential: 'user-token', user: { id: 'u' } as any };
const route = (name: string) => MCP_ROUTES.find((r) => r.name === name)!;
const file = (text = 'policy') => ({ fileName: 'policy.txt', mimeType: 'text/plain', contentBase64: Buffer.from(text).toString('base64') });

describe('MCP configuration and bounded files', () => {
  it('defaults off and rejects unsafe or malformed configuration', () => {
    const config = (values: any) => readMcpConfig({ get: (key: string) => values[key] } as any);
    expect(config({}).enabled).toBe(false);
    expect(config({}).maxRequestBytes).toBe(16777216);
    for (const value of ['abc', '0', '-1', '1.5', '999999999']) expect(() => config({ MCP_MAX_REQUEST_BYTES: value })).toThrow();
    expect(() => config({ MCP_ENABLED: 'tru' })).toThrow();
    expect(() => config({ MCP_MAX_CONCURRENT_CALLS: 1000 })).toThrow();
  });

  it('encodes version, manifest and bulk fields with intact bytes and relative paths', async () => {
    const version = buildMultipart('version', { file: file() }, { changeSummary: 'Updated' });
    expect((version.get('file') as File).name).toBe('policy.txt');
    expect(await (version.get('file') as File).text()).toBe('policy');
    expect(version.get('changeSummary')).toBe('Updated');
    expect(buildMultipart('manifest', { manifest: file('filepath,title'), files: [file()] }, {}).getAll('files')).toHaveLength(1);
    expect(buildMultipart('bulk', { files: [file()] }, { relativePaths: ['folder/policy.txt'] }).get('relativePaths')).toBe('["folder/policy.txt"]');
  });

  it('rejects noncanonical base64, paths, unknown fields and aggregate size before dispatch', () => {
    for (const contentBase64 of ['!', 'YQ', 'YQ==\n', 'YR==', 'data:text/plain;base64,YQ==']) {
      expect(() => buildMultipart('version', { file: { ...file(), contentBase64 } }, {})).toThrow();
    }
    for (const fileName of ['../policy.txt', 'folder/policy.txt', 'a\\b.txt', 'a\r\n.txt']) expect(() => buildMultipart('version', { file: { ...file(), fileName } }, {})).toThrow();
    expect(() => buildMultipart('version', { file: { ...file(), filePath: 'C:/secret' } as any }, {})).toThrow();
    expect(() => buildMultipart('bulk', { files: [file('123'), file('456')] }, {}, 5)).toThrow();
  });
});

describe('MCP dispatch preserves selected routes and never retries', () => {
  let server: Server;
  let port: number;
  let seen = 0;
  let oversizedClosed = false;
  beforeAll(async () => {
    server = createServer((req, res) => {
      seen++;
      if (req.url?.includes('advertised')) {
        res.on('close', () => { oversizedClosed = true; });
        res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': '1000000' });
        res.flushHeaders();
        res.write('x');
        return;
      }
      if (req.url?.includes('slow')) return setTimeout(() => { res.end('{"created":true}'); }, 150);
      if (req.url?.includes('redirect')) { res.writeHead(302, { location: 'http://example.com/secret' }); return res.end(); }
      if (req.url?.includes('forbidden')) { res.writeHead(403, { 'content-type': 'application/json' }); return res.end('{"message":"Forbidden"}'); }
      if (req.url?.includes('server-error')) { res.writeHead(500); return res.end('private database credentials'); }
      if (req.url?.includes('empty')) { res.writeHead(204); return res.end(); }
      if (req.url?.includes('binary')) { res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="policy.pdf"' }); return res.end(Buffer.from('%PDF-example')); }
      if (req.url?.includes('big')) { res.writeHead(201, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ text: 'x'.repeat(1000) })); }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ url: req.url, authorization: req.headers.authorization, apiKey: req.headers['x-api-key'] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as any).port;
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });

  it('uses a fixed loopback destination, strict path values and typed query serialization', () => {
    const url = buildToolUrl(port, route('documents_get'), { path: { id: 'doc-123' }, query: { page: 2, includeArchived: false } });
    expect(url.origin).toBe(`http://127.0.0.1:${port}`);
    expect(url.pathname).toBe('/api/documents/doc-123');
    expect(url.searchParams.get('includeArchived')).toBe('false');
    for (const id of ['../auth/me', '..', 'a/b', 'a%2fb', 'a?x=1', 'http://evil']) expect(() => buildToolUrl(port, route('documents_get'), { path: { id } })).toThrow();
    expect(() => buildToolUrl(port, route('documents_get'), {})).toThrow();
  });

  it('forwards only the bound identity and preserves JSON, empty success and binary bytes', async () => {
    const json = await dispatchTool(port, route('documents_get'), { path: { id: 'doc' } }, identity, limits);
    expect(json.result.structuredContent?.authorization).toBe('Bearer user-token');
    const api = await dispatchTool(port, route('documents_get'), { path: { id: 'doc' } }, { kind: 'api', credential: 'client.secret', client: {} as any }, limits);
    expect(api.result.structuredContent?.apiKey).toBe('client.secret');
    expect(api.result.structuredContent?.authorization).toBeUndefined();
    const empty = await dispatchTool(port, route('documents_get'), { path: { id: 'empty' } }, identity, limits);
    expect(empty.result.isError).not.toBe(true);
    const binary = await dispatchTool(port, route('documents_get'), { path: { id: 'binary' } }, identity, limits);
    const resource = binary.result.content[0] as any;
    expect(resource.resource.mimeType).toBe('application/pdf');
    expect(Buffer.from(resource.resource.blob, 'base64').toString()).toBe('%PDF-example');
  });

  it('returns safe REST failures and blocks redirects without leaking response internals', async () => {
    expect((await dispatchTool(port, route('documents_get'), { path: { id: 'forbidden' } }, identity, limits)).status).toBe(403);
    const error = await dispatchTool(port, route('documents_get'), { path: { id: 'server-error' } }, identity, limits);
    expect(JSON.stringify(error.result)).not.toContain('private database');
    expect((await dispatchTool(port, route('documents_get'), { path: { id: 'redirect' } }, identity, limits)).result.isError).toBe(true);
  });

  it('closes an unfinished upstream response when advertised Content-Length exceeds the limit', async () => {
    const result = await dispatchTool(port, route('documents_get'), { path: { id: 'advertised' } }, identity, { ...limits, maxResponseBytes: 256, timeoutMs: 50 });
    expect(result.status).toBe(413);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(oversizedClosed).toBe(true);
  });

  it('reports timeout and post-mutation delivery limits as uncertain with exactly one request', async () => {
    const before = seen;
    const timed = await dispatchTool(port, route('documents_create'), { query: { q: 'slow' }, body: { title: 'Policy' } }, identity, { ...limits, timeoutMs: 75 });
    expect(timed.result.structuredContent?.outcome).toBe('uncertain');
    expect(seen).toBe(before + 1);
    const big = await dispatchTool(port, route('documents_create'), { query: { q: 'big' }, body: { title: 'Policy' } }, identity, { ...limits, maxResponseBytes: 256 });
    expect(big.result.isError).toBe(true);
    expect(big.result.structuredContent?.outcome).toBe('uncertain');
  });
});
