import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const endpoint = process.env.POLICYMANAGER_MCP_URL;
const token = process.env.POLICYMANAGER_ACCESS_TOKEN;
const apiKey = process.env.POLICYMANAGER_API_KEY;
if (!endpoint || (!!token === !!apiKey)) throw new Error('Set POLICYMANAGER_MCP_URL and exactly one of POLICYMANAGER_ACCESS_TOKEN / POLICYMANAGER_API_KEY');
const url = new URL(endpoint);
if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Use HTTPS outside localhost');
const client = new Client({ name: 'policymanager-smoke', version: '1.0.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : { 'X-Api-Key': apiKey } } }));
  const { tools } = await client.listTools();
  if (!tools.some((tool) => tool.name === 'health_check')) throw new Error('Health tool is missing');
  const result = await client.callTool({ name: 'health_check', arguments: {} });
  if (result.isError || result.structuredContent?.status !== 'ok') throw new Error('Health tool failed');
  await client.ping();
  console.log(`MCP smoke passed: authenticated handshake, ${tools.length} visible tools, health call, ping.`);
} finally { await client.close(); }
