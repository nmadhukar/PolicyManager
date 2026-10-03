import type { ConfigService } from '@nestjs/config';

export interface McpConfig {
  enabled: boolean;
  allowedOrigins: string[];
  maxRequestBytes: number;
  maxResponseBytes: number;
  maxConcurrentCalls: number;
  timeoutMs: number;
}

export function readMcpConfig(config: Pick<ConfigService, 'get'>): McpConfig {
  const enabled = String(config.get('MCP_ENABLED') ?? 'false');
  if (!['true', 'false'].includes(enabled)) throw new Error('MCP_ENABLED must be true or false');
  const integer = (key: string, fallback: number, maximum: number) => {
    const raw = String(config.get(key) ?? fallback);
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${key} must be an integer between 1 and ${maximum}`);
    return value;
  };
  const allowedOrigins = String(config.get('MCP_ALLOWED_ORIGINS') ?? '').split(',').map((v) => v.trim()).filter(Boolean);
  for (const origin of allowedOrigins) {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) throw new Error('MCP_ALLOWED_ORIGINS must contain exact HTTP(S) origins');
  }
  return {
    enabled: enabled === 'true', allowedOrigins,
    maxRequestBytes: integer('MCP_MAX_REQUEST_BYTES', 16777216, 80 * 1024 * 1024),
    maxResponseBytes: integer('MCP_MAX_RESPONSE_BYTES', 16777216, 80 * 1024 * 1024),
    maxConcurrentCalls: integer('MCP_MAX_CONCURRENT_CALLS', 4, 32),
    timeoutMs: integer('MCP_TOOL_TIMEOUT_MS', 120000, 300000),
  };
}
