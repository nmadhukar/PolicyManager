import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthenticatedApiClient } from './api-client.types';

/**
 * Injects the authenticated {@link AuthenticatedApiClient} (populated by
 * {@link ApiKeyGuard}) into a public-API controller handler. Only meaningful on
 * routes protected by ApiKeyGuard.
 */
export const CurrentApiClient = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedApiClient =>
    ctx.switchToHttp().getRequest().apiClient as AuthenticatedApiClient,
);
