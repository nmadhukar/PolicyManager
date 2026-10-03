/** Offline documentation export: real controller metadata, inert constructor dependencies, no DB or listening socket. */
import 'reflect-metadata';
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ApiClientsService } from '../apps/api/src/api-clients/api-clients.service';
import { createCatalog, publicTool } from '../apps/api/src/mcp/mcp.catalog';
import { MCP_EXCLUSIONS } from '../apps/api/src/mcp/mcp.routes';

async function collect(dir: string): Promise<any[]> {
  const types: any[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'mcp') continue;
    const file = join(dir, entry.name);
    if (entry.isDirectory()) types.push(...await collect(file));
    else if (entry.name.endsWith('.controller.ts')) types.push(...Object.values(await import(file)).filter((type: any) => typeof type === 'function' && type.name.endsWith('Controller')));
  }
  return types;
}

async function main() {
  const root = resolve(__dirname, '..');
  const types = await collect(join(root, 'apps/api/src'));
  const dependencies = new Set([...types.flatMap((type) => Reflect.getMetadata('design:paramtypes', type) ?? []), ApiClientsService]);
  const moduleRef = await Test.createTestingModule({ controllers: types, providers: [...dependencies].map((provide) => ({ provide, useValue: {} })) }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api', { exclude: ['health'] });
  try {
    const doc = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('PolicyManager API').setVersion('1.0').build());
    const catalog = createCatalog(doc);
    const output = { version: '1.0.0', endpoint: '/api/mcp', tools: catalog.map((tool) => ({ ...publicTool(tool), rest: { method: tool.method, path: tool.path }, audience: tool.audience, permissions: tool.permissions, scopes: tool.scopes })), exclusions: MCP_EXCLUSIONS };
    const json = JSON.stringify(output, null, 2) + '\n';
    const destination = join(root, 'docs/api/mcp-tools.json');
    if (process.argv.includes('--check')) {
      if (readFileSync(destination, 'utf8') !== json) throw new Error('MCP catalog docs are stale; run npm run mcp:catalog');
    } else writeFileSync(destination, json);
    console.log(`MCP catalog: ${catalog.length} tools, ${MCP_EXCLUSIONS.length} exclusions (${process.argv.includes('--check') ? 'verified' : 'exported'})`);
  } finally { await app.close(); }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
