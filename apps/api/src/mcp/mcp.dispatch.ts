import { HttpException } from '@nestjs/common';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { buildMultipart } from './mcp.files';
import type { McpConfig } from './mcp.config';
import type { McpIdentity, McpRoute } from './mcp.routes';

export interface DispatchResult { result: CallToolResult; status: number }
export interface ToolArgs { path?: Record<string, string>; query?: Record<string, any>; body?: Record<string, any>; files?: Record<string, any> }

export function toolFailure(status: number, message: string, uncertain = false): DispatchResult {
  const data = { status, message, outcome: uncertain ? 'uncertain' : 'rejected' };
  return { status, result: { isError: true, structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] } };
}

/** The destination is a listening socket port chosen by bootstrap, NEVER a URL/Host from the caller. */
export function buildToolUrl(port: number, route: McpRoute, args: ToolArgs): URL {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MCP dispatch port is unavailable');
  const pathname = route.path.replace(/:(\w+)/g, (_match, name: string) => {
    const value = args.path?.[name];
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid path parameter');
    return encodeURIComponent(value);
  });
  const url = new URL(pathname, `http://127.0.0.1:${port}`);
  for (const [key, value] of Object.entries(args.query ?? {})) {
    if (value === undefined || value === null) continue;
    // Express's default query parser understands repeated array keys.
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item));
  }
  return url;
}

async function readBounded(response: globalThis.Response, maximum: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    // Even an advertised oversized body must enter the reader cleanup path;
    // otherwise an unfinished export outlives the released dispatch slot.
    if (Number(response.headers.get('content-length')) > maximum) throw new Error('response_limit');
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum) throw new Error('response_limit');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

function encodeResult(route: McpRoute, response: globalThis.Response, bytes: Buffer): CallToolResult {
  const mimeType = (response.headers.get('content-type') ?? 'application/octet-stream').split(';')[0];
  if (response.status === 204 || !bytes.length) {
    const data = { success: true, status: response.status };
    return { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
  }
  if (mimeType === 'application/json' || mimeType.endsWith('+json')) {
    const value = JSON.parse(bytes.toString('utf8'));
    const data = value && typeof value === 'object' && !Array.isArray(value) ? value : { value };
    return { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(value) }] };
  }
  const disposition = response.headers.get('content-disposition') ?? '';
  const fileName = (/filename="?([^";]+)/i.exec(disposition)?.[1] ?? `${route.name}.bin`).replace(/[\/\\\x00-\x1f]/g, '_').slice(0, 255);
  return { structuredContent: { fileName, mimeType, sizeBytes: bytes.length }, content: [{ type: 'resource', resource: { uri: `policymanager://mcp/results/${route.name}/${encodeURIComponent(fileName)}`, mimeType, blob: bytes.toString('base64') } }] };
}

const restMessages: Record<number, string> = {
  400: 'The REST API rejected the input. Check required fields and document state.',
  401: 'Your credential expired or was revoked. Authenticate again outside chat.',
  403: 'Your account lacks permission, document access, or ownership for this action.',
  404: 'The requested item does not exist or is outside your access scope.',
  409: 'The item changed or this action conflicts with its current state. Read it again.',
  413: 'The file or request exceeds a configured limit. Split the batch or reduce its size.',
  429: 'Rate limit reached. Wait before trying another call.',
};

export async function dispatchTool(port: number, route: McpRoute, args: ToolArgs, identity: McpIdentity, config: McpConfig, externalSignal?: AbortSignal): Promise<DispatchResult> {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  externalSignal?.addEventListener('abort', cancel, { once: true });
  if (externalSignal?.aborted) abort.abort();
  const timer = setTimeout(cancel, config.timeoutMs);
  let dispatched = false;
  try {
    const url = buildToolUrl(port, route, args);
    const headers: Record<string, string> = { 'user-agent': 'PolicyManager-MCP/1.0' };
    if (identity.kind === 'user') headers.authorization = `Bearer ${identity.credential}`;
    else headers['x-api-key'] = identity.credential;
    let body: BodyInit | undefined;
    if (route.files) body = buildMultipart(route.files, args.files ?? {}, args.body ?? {});
    else if (args.body !== undefined) {
      body = JSON.stringify(args.body);
      if (Buffer.byteLength(body) > config.maxRequestBytes) return toolFailure(413, restMessages[413]);
      headers['content-type'] = 'application/json';
    }
    dispatched = true;
    const response = await fetch(url, { method: route.method, headers, body, redirect: 'manual', signal: abort.signal });
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); return toolFailure(502, 'Unexpected REST redirect blocked.', !route.readOnly); }
    if (!response.ok) { await response.body?.cancel(); return toolFailure(response.status, restMessages[response.status] ?? 'The REST API failed. Check server health and audit records.', response.status >= 500 && !route.readOnly); }
    const bytes = await readBounded(response, config.maxResponseBytes);
    const result = encodeResult(route, response, bytes);
    // Enforce the encoded MCP result size as well: binary base64 and text+JSON duplication add overhead.
    if (Buffer.byteLength(JSON.stringify(result)) > config.maxResponseBytes) throw new Error('response_limit');
    return { status: response.status, result };
  } catch (error) {
    if (error instanceof HttpException) return toolFailure(error.getStatus(), restMessages[error.getStatus()] ?? 'Invalid tool input.');
    const limited = error instanceof Error && error.message === 'response_limit';
    return toolFailure(limited ? 413 : abort.signal.aborted ? 504 : 502,
      limited ? 'The result exceeds the MCP delivery limit. Check the item before repeating this action.' : 'The REST result could not be delivered. Check the item and server health before repeating this action.',
      dispatched && !route.readOnly);
  } finally { clearTimeout(timer); externalSignal?.removeEventListener('abort', cancel); }
}
