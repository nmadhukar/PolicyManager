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
 * Best-effort client IP resolution. Prefers the first hop of `X-Forwarded-For`
 * (set by a trusted proxy/load balancer), then Express's own `req.ip`, then the
 * raw socket address. Returns undefined rather than an empty string so the audit
 * column stays null when genuinely unknown.
 */
export function clientIp(req: RequestLike): string | undefined {
  const fwd = req.headers?.['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) {
    const first = fwd.split(',')[0]?.trim();
    if (first) return first;
  } else if (Array.isArray(fwd) && fwd.length > 0) {
    const first = fwd[0]?.split(',')[0]?.trim();
    if (first) return first;
  }
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
