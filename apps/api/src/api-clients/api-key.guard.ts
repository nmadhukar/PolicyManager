import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ApiScope } from '@policymanager/shared';
import { ApiClientsService } from './api-clients.service';
import { API_SCOPES_KEY } from './require-scope.decorator';

/** Minimal request shape we read for the API credential. */
interface RequestLike {
  headers?: Record<string, string | string[] | undefined>;
  apiClient?: unknown;
}

/**
 * Extracts the raw `clientId.secret` credential from either
 * `Authorization: Bearer <cred>` or `X-Api-Key: <cred>`. Returns undefined when
 * neither is present. Exported for unit testing.
 */
export function extractApiCredential(req: RequestLike): string | undefined {
  const auth = headerValue(req.headers?.['authorization']);
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match) return match[1].trim();
  }
  const apiKey = headerValue(req.headers?.['x-api-key']);
  if (apiKey) return apiKey.trim();
  return undefined;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

/**
 * Authenticates + authorizes public API (`/api/v1`) requests (AGENTS.md §8):
 *  - no/invalid/disabled/revoked credential  => 401 Unauthorized
 *  - authenticated but missing a @RequireScope => 403 Forbidden
 *
 * On success the {@link AuthenticatedApiClient} is attached to `request.apiClient`.
 * Deliberately SEPARATE from JwtAuthGuard so the two auth schemes never collide:
 * this guard only runs on the public controllers that opt in via `@UseGuards`.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly clients: ApiClientsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestLike>();

    const raw = extractApiCredential(req);
    if (!raw) {
      throw new UnauthorizedException('Missing API credentials');
    }

    const client = await this.clients.authenticate(raw);
    if (!client) {
      throw new UnauthorizedException('Invalid API credentials');
    }

    const required =
      this.reflector.getAllAndOverride<ApiScope[]>(API_SCOPES_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    const held = new Set(client.scopes);
    if (!required.every((scope) => held.has(scope))) {
      throw new ForbiddenException('Your API key is missing a required scope');
    }

    req.apiClient = client;
    return true;
  }
}
