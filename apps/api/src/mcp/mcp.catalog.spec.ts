import 'reflect-metadata';
import { readdirSync } from 'fs';
import { join } from 'path';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import { createCatalog, canUseTool } from './mcp.catalog';
import { MCP_ROUTES, MCP_EXCLUSIONS } from './mcp.routes';
import { PERMISSIONS_KEY } from '../auth/decorators/require-permission.decorator';
import { API_SCOPES_KEY } from '../api-clients/require-scope.decorator';

function controllerFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const target = join(dir, entry.name);
    return entry.isDirectory() ? controllerFiles(target) : entry.name.endsWith('.controller.ts') ? [target] : [];
  });
}

describe('MCP complete REST contract', () => {
  it('maps all real Nest controller routes exactly once, including Swagger exclusions', async () => {
    const actual: string[] = [];
    for (const file of controllerFiles(join(__dirname, '..'))) {
      if (file.includes(`${join('src', 'mcp')}`)) continue;
      const exports = await import(file);
      for (const type of Object.values(exports) as any[]) {
        if (typeof type !== 'function' || !Reflect.hasMetadata(PATH_METADATA, type)) continue;
        const prefix = Reflect.getMetadata(PATH_METADATA, type);
        for (const name of Object.getOwnPropertyNames(type.prototype)) {
          const handler = type.prototype[name];
          const method = Reflect.getMetadata(METHOD_METADATA, handler);
          if (method === undefined) continue;
          const suffix = Reflect.getMetadata(PATH_METADATA, handler);
          const route = [prefix, suffix].filter((part) => part && part !== '/').join('/');
          actual.push(`${RequestMethod[method]} /${prefix === 'health' ? '' : 'api/'}${route}`);
          const mapped = MCP_ROUTES.find((r) => `${r.method} ${r.path}` === actual[actual.length - 1]);
          if (mapped) {
            expect(mapped.permissions).toEqual(Reflect.getMetadata(PERMISSIONS_KEY, handler) ?? Reflect.getMetadata(PERMISSIONS_KEY, type) ?? []);
            expect(mapped.scopes).toEqual(Reflect.getMetadata(API_SCOPES_KEY, handler) ?? Reflect.getMetadata(API_SCOPES_KEY, type) ?? []);
          }
        }
      }
    }
    const accounted = [...MCP_ROUTES, ...MCP_EXCLUSIONS].map((route) => `${route.method} ${route.path}`);
    expect(accounted.sort()).toEqual(actual.sort());
    expect(new Set(accounted).size).toBe(116);
    expect(MCP_ROUTES).toHaveLength(107);
    expect(MCP_EXCLUSIONS).toHaveLength(9);
    expect(new Set(MCP_ROUTES.map((r) => r.name)).size).toBe(107);
  });

  it('derives strict schemas with required body/path and typed query arguments', () => {
    const catalog = createCatalog({
      paths: {
        '/api/documents': {
          post: { summary: 'Create policy', requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Create' } } } } },
          get: { parameters: [{ name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } }] },
        },
        '/api/documents/{id}': { patch: { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] } },
      },
      components: { schemas: { Create: { type: 'object', required: ['title'], properties: { title: { type: 'string' }, accessLevel: { type: 'string', enum: ['public', 'confidential'] } } } } },
    } as unknown as OpenAPIObject, MCP_ROUTES.filter((r) => ['documents_create', 'documents_list', 'documents_update'].includes(r.name)));
    const create = catalog.find((r) => r.name === 'documents_create')!;
    expect(create.validate({ body: { title: 'Policy', accessLevel: 'confidential' } })).toBe(true);
    expect(create.validate({ body: {} })).toBe(false);
    expect(create.validate({ body: { title: 'Policy', actorUserId: 'another-user' } })).toBe(false);
    expect(create.validate({ body: { title: 'Policy', accessLevel: 'invalid' } })).toBe(false);
    expect(create.annotations.readOnlyHint).toBe(false);
    expect(catalog.find((r) => r.name === 'documents_list')!.validate({ query: { page: 0 } })).toBe(false);
    expect(catalog.find((r) => r.name === 'documents_update')!.validate({})).toBe(false);
  });

  it('separates public API scopes, user permissions, and temporary-password recovery tools', () => {
    const write = MCP_ROUTES.find((r) => r.name === 'documents_create')!;
    const publicRead = MCP_ROUTES.find((r) => r.name === 'public_documents_list')!;
    const user = { kind: 'user' as const, credential: 'test', user: { id: 'u', permissions: ['document.write'], mustChangePassword: false } as any };
    const api = { kind: 'api' as const, credential: 'test', client: { id: 'c', scopes: ['documents:read'] } as any };
    expect(canUseTool(write, user)).toBe(true);
    expect(canUseTool(write, api)).toBe(false);
    expect(canUseTool(publicRead, user)).toBe(false);
    expect(canUseTool(publicRead, api)).toBe(true);
    user.user.permissions = [];
    expect(canUseTool(write, user)).toBe(false);
    user.user.mustChangePassword = true;
    expect(canUseTool(MCP_ROUTES.find((r) => r.name === 'auth_me')!, user)).toBe(true);
    expect(canUseTool(MCP_ROUTES.find((r) => r.name === 'reviews_list')!, user)).toBe(false);
  });

  it('fails closed on stale routes and unresolved schema references', () => {
    expect(() => createCatalog({ paths: {} } as any, [MCP_ROUTES[0]])).toThrow('Missing OpenAPI operation');
    expect(() => createCatalog({ paths: { '/api/documents': { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Missing' } } } } } } } } as any,
      [MCP_ROUTES.find((r) => r.name === 'documents_create')!])).toThrow('Unresolved');
  });

  it('preserves arbitrary dictionary fields that REST DTOs explicitly allow', () => {
    const catalog = createCatalog({ paths: { '/api/documents': { post: { requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { filters: { type: 'object' } } } } } } } } } } as any,
      [MCP_ROUTES.find((r) => r.name === 'documents_create')!]);
    expect(catalog[0].validate({ body: { filters: { categoryId: 'category', q: 'policy' } } })).toBe(true);
  });
});
