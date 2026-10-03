import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { OpenAPIObject } from '@nestjs/swagger';
import type { Response } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { AuditService } from '../audit/audit.service';
import { requestContextOf } from '../audit/request-context';
import { canUseTool, createCatalog, publicTool, type CatalogTool } from './mcp.catalog';
import { readMcpConfig } from './mcp.config';
import { dispatchTool, toolFailure, type DispatchResult, type ToolArgs } from './mcp.dispatch';
import type { McpRequest } from './mcp.guard';

@Injectable()
export class McpService {
  readonly config;
  catalog: CatalogTool[] = [];
  private portProvider?: () => number;
  private active = 0;

  constructor(config: ConfigService, private readonly audit: AuditService) { this.config = readMcpConfig(config); }

  configure(document: OpenAPIObject, portProvider: () => number): void {
    this.catalog = this.config.enabled ? createCatalog(document) : [];
    this.portProvider = portProvider;
  }

  async handle(req: McpRequest, res: Response): Promise<void> {
    const identity = req.mcpIdentity!;
    // A new server/transport per HTTP request binds closures to ONE authenticated identity.
    // Reusing a server across callers would leak credentials and discovery state.
    const server = new Server({ name: 'policymanager', version: '1.0.0' }, {
      capabilities: { tools: {} },
      instructions: 'Use named PolicyManager tools with the caller\'s existing permissions. Documents and version history are immutable/soft-deleted. Never automatically retry a mutation after an uncertain outcome. Credentials must stay outside shared chats.',
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const disconnect = new AbortController();
    server.setRequestHandler(ListToolsRequestSchema, () => {
      const tools = this.catalog.filter((tool) => canUseTool(tool, identity)).map(publicTool);
      if (Buffer.byteLength(JSON.stringify({ tools })) > this.config.maxResponseBytes) throw new McpError(ErrorCode.InternalError, 'Tool catalog exceeds configured MCP response limit');
      return { tools };
    });
    server.setRequestHandler(CallToolRequestSchema, async (call, extra) => {
      const tool = this.catalog.find((entry) => entry.name === call.params.name);
      let result: DispatchResult = toolFailure(400, 'Unknown tool');
      let counted = false;
      try {
        if (!tool) throw new McpError(ErrorCode.InvalidParams, 'Unknown PolicyManager tool');
        if (!canUseTool(tool, identity)) result = toolFailure(403, 'This tool is outside your permissions or API scopes.');
        else if (!tool.validate(call.params.arguments ?? {})) {
          // AJV paths/keywords explain the input error; never include values from arguments.
          throw new McpError(ErrorCode.InvalidParams, `Invalid tool arguments: ${tool.validate.errors?.map((e) => `${e.instancePath || '/'} ${e.keyword}`).join(', ')}`);
        } else if (this.active >= this.config.maxConcurrentCalls) result = toolFailure(429, 'MCP concurrent-call limit reached. Wait before another call.');
        else {
          this.active++; counted = true;
          const signal = AbortSignal.any([extra.signal, disconnect.signal]);
          result = await dispatchTool(this.portProvider!(), tool, (call.params.arguments ?? {}) as ToolArgs, identity, this.config, signal);
        }
        return result.result;
      } finally {
        if (counted) this.active--;
        const safeName = /^[a-z0-9_]{1,64}$/.test(call.params.name) ? call.params.name : '<invalid>';
        const path = (call.params.arguments as ToolArgs | undefined)?.path;
        const safeId = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value) ? value : null;
        const documentId = tool?.path.startsWith('/api/documents/:') ? safeId(path?.id ?? path?.documentId) : null;
        await this.audit.record({
          action: 'mcp.tool.called', source: 'api',
          ...(identity.kind === 'user' ? { actorUserId: identity.user.id } : { apiClientId: identity.client.id }),
          ...requestContextOf(req), targetType: 'mcp_tool',
          // IDs stay in metadata so a 404 does not fail the audit row's document FK.
          metadata: { tool: safeName, method: tool?.method ?? null, route: tool?.path ?? null, documentId, versionId: safeId(path?.versionId), status: result.status, outcome: result.result.isError ? (result.result.structuredContent?.outcome ?? 'rejected') : 'completed' },
        });
      }
    });
    res.once('close', () => {
      if (!res.writableFinished) disconnect.abort();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }
}
