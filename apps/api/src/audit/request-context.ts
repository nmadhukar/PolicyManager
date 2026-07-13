import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Client network context captured for the audit trail. Both fields are optional
 * because a request may legitimately omit them (server-to-server calls, tests).
 */
export interface RequestContext {
  ipAddress?: string;
  userAgent?: string;
}

/** Minimal shape of an Express request we read for the audit context. */
interface RequestLike {
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}

/**
 * Client IP for the audit/attestation trail. We trust ONLY Express's computed
 * `req.ip`, which honours the app's `trust proxy` hop count (TRUST_PROXY_HOPS,
 * set in main.ts) — so behind N known proxies it is the real client, and with the
 * default of 0 it is the direct socket peer. We deliberately DO NOT read
 * `X-Forwarded-For` ourselves: an unconditional first-hop read let any client
 * spoof the recorded IP on attestation evidence (SL1). Falls back to the raw
 * socket address; returns undefined (not '') so the column stays null when unknown.
 */
export function clientIp(req: RequestLike): string | undefined {
  return req.ip || req.socket?.remoteAddress || undefined;
}

/** Extracts the audit request context (IP + user-agent) from an Express request. */
export function requestContextOf(req: RequestLike): RequestContext {
  const ua = req.headers?.['user-agent'];
  return {
    ipAddress: clientIp(req),
    userAgent: typeof ua === 'string' ? ua : Array.isArray(ua) ? ua[0] : undefined,
  };
}

/**
 * Injects the {@link RequestContext} (IP + user-agent) into a controller handler
 * so it can be threaded to {@link AuditService.record}. Purely descriptive — it
 * never affects authorization.
 */
export const ReqContext = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestContext =>
    requestContextOf(ctx.switchToHttp().getRequest()),
);
