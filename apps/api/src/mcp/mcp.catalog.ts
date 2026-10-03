import Ajv, { ValidateFunction } from 'ajv';
import type { OpenAPIObject } from '@nestjs/swagger';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { MCP_ROUTES, type McpIdentity, type McpRoute } from './mcp.routes';

export interface CatalogTool extends McpRoute {
  description: string;
  inputSchema: Tool['inputSchema'];
  annotations: NonNullable<Tool['annotations']>;
  validate: ValidateFunction;
}

export function canUseTool(route: McpRoute, identity: McpIdentity): boolean {
  if (route.audience === 'both') return true;
  if (route.audience !== identity.kind) return false;
  if (identity.kind === 'api') return route.scopes.every((scope) => identity.client.scopes.includes(scope as any));
  if (identity.user.mustChangePassword && !['auth_me', 'auth_change_password'].includes(route.name)) return false;
  return route.permissions.every((permission) => identity.user.permissions.includes(permission));
}

/** OpenAPI-only keywords are removed; local refs are resolved before sending tools to a model. */
function normalize(schema: any, document: OpenAPIObject, seen = new Set<string>()): any {
  if (!schema || typeof schema !== 'object') return schema;
  if (schema.$ref) {
    if (!schema.$ref.startsWith('#/components/schemas/') || seen.has(schema.$ref)) throw new Error(`Unresolved/cyclic MCP schema: ${schema.$ref}`);
    const resolved = document.components?.schemas?.[schema.$ref.split('/').pop()!];
    if (!resolved) throw new Error(`Unresolved MCP schema: ${schema.$ref}`);
    return normalize(resolved, document, new Set([...seen, schema.$ref]));
  }
  const result: any = {};
  for (const [key, value] of Object.entries(schema)) {
    if (['example', 'examples', 'nullable', 'readOnly', 'writeOnly', 'xml', 'discriminator'].includes(key)) continue;
    if (key === 'properties') result.properties = Object.fromEntries(Object.entries(value as object).map(([k, v]) => [k, normalize(v, document, seen)]));
    else if (['items', 'additionalProperties'].includes(key) && typeof value === 'object') result[key] = normalize(value, document, seen);
    else if (['allOf', 'anyOf', 'oneOf'].includes(key)) result[key] = (value as any[]).map((v) => normalize(v, document, seen));
    else result[key] = value;
  }
  // A bare Object in Swagger represents a DTO dictionary (saved-search filters,
  // notification overrides). Only objects with declared fields are closed.
  if (result.properties) result.additionalProperties ??= false;
  if (schema.nullable) return { anyOf: [result, { type: 'null' }] };
  return result;
}

const object = (properties: Record<string, any>, required: string[] = []) => ({ type: 'object' as const, properties, required, additionalProperties: false });
const file = object({
  fileName: { type: 'string', minLength: 1, maxLength: 255, description: 'Original filename with supported extension; no server path.' },
  mimeType: { type: 'string', minLength: 1, maxLength: 150 },
  contentBase64: { type: 'string', description: 'Complete standard padded base64 file bytes (no data URL).' },
}, ['fileName', 'mimeType', 'contentBase64']);

export function createCatalog(document: OpenAPIObject, routes = MCP_ROUTES): CatalogTool[] {
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
  return routes.map((route) => {
    const openPath = route.path.replace(/:([\w]+)/g, '{$1}');
    const item: any = document.paths[openPath];
    const operation = item?.[route.method.toLowerCase()];
    if (!operation) throw new Error(`Missing OpenAPI operation: ${route.method} ${route.path}`);
    const properties: Record<string, any> = {};
    const required: string[] = [];
    const pathParams = [...route.path.matchAll(/:(\w+)/g)].map((m) => m[1]);
    if (pathParams.length) {
      properties.path = object(Object.fromEntries(pathParams.map((name) => [name, { type: 'string', minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9_-]+$' }])), pathParams);
      required.push('path');
    }
    const params = [...(item.parameters ?? []), ...(operation.parameters ?? [])];
    const query = params.filter((p: any) => p.in === 'query').map((p: any) => ({ ...p }));
    // Swagger cannot infer optional inline @Query arguments without the CLI
    // plugin. These three reviewed controller contracts need explicit overrides.
    if (['rag_chat_list_conversations', 'rag_chat_get_conversation'].includes(route.name)) {
      for (const parameter of query) { parameter.required = false; parameter.schema = { type: 'integer', minimum: parameter.name === 'offset' ? 0 : 1 }; }
    }
    if (route.name === 'storage_admin_list_prefixes') {
      for (const parameter of query) parameter.required = parameter.name === 'bucket';
    }
    if (query.length) {
      properties.query = object(Object.fromEntries(query.map((p: any) => [p.name, normalize(p.schema ?? { type: 'string' }, document)])), query.filter((p: any) => p.required).map((p: any) => p.name));
      if (query.some((p: any) => p.required)) required.push('query');
    }
    if (route.files) {
      if (route.files === 'version') {
        properties.files = object({ file }, ['file']);
        properties.body = object({ changeSummary: { type: 'string' } });
      } else if (route.files === 'manifest') {
        properties.files = object({ manifest: file, files: { type: 'array', items: file, maxItems: 200 } }, ['manifest']);
      } else {
        properties.files = object({ files: { type: 'array', items: file, minItems: 1, maxItems: 200 } }, ['files']);
        properties.body = object({ relativePaths: { type: 'array', items: { type: 'string' }, maxItems: 200 } });
      }
      required.push('files');
    } else {
      const schema = operation.requestBody?.content?.['application/json']?.schema;
      if (schema) {
        properties.body = normalize(schema, document);
        required.push('body');
      }
    }
    const inputSchema = object(properties, required);
    let description = `${operation.summary ?? route.name}. ${operation.description ?? ''} REST: ${route.method} ${route.path}. Existing permissions, ACLs and ownership checks apply.`;
    if (!route.readOnly) description += ' Changes state or issues editor credentials; never automatically retry after an uncertain outcome.';
    if (/password/.test(route.name) || ['api_clients_create', 'api_clients_rotate'].includes(route.name)) description += ' Sensitive inputs/results may enter chat history; avoid exposing credentials to shared chats.';
    return { ...route, description, inputSchema, annotations: { readOnlyHint: route.readOnly, destructiveHint: !route.readOnly, idempotentHint: route.readOnly, openWorldHint: false }, validate: ajv.compile(inputSchema) };
  });
}

/** Never expose dispatch internals or validator functions in tools/list. */
export function publicTool(tool: CatalogTool): Tool {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations };
}
