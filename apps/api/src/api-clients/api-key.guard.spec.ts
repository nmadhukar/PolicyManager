import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ApiScope } from '@policymanager/shared';
import { ApiKeyGuard, extractApiCredential } from './api-key.guard';
import type { AuthenticatedApiClient } from './api-client.types';

/**
 * ApiKeyGuard is the security boundary of the public API (AGENTS.md §8):
 *   missing / invalid / disabled / revoked credential -> 401,
 *   authenticated but missing scope                    -> 403,
 *   valid + scoped                                     -> true (+ attaches client).
 * The disabled/revoked "-> null -> 401" cases are exercised at the service layer;
 * here we assert the guard's mapping of authenticate()'s result.
 */
describe('ApiKeyGuard', () => {
  const client: AuthenticatedApiClient = {
    id: 'c1',
    name: 'EMR',
    scopes: ['documents:read', 'content:read'],
    allowedCategoryIds: [],
  };

  const makeContext = (headers: Record<string, string>): { ctx: ExecutionContext; req: { headers: Record<string, string>; apiClient?: unknown } } => {
    const req: { headers: Record<string, string>; apiClient?: unknown } = { headers };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => () => undefined,
      getClass: () => class {},
    } as unknown as ExecutionContext;
    return { ctx, req };
  };

  const guardWith = (
    authenticate: jest.Mock,
    required: ApiScope[] | undefined,
  ): ApiKeyGuard => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(required),
    } as unknown as Reflector;
    const svc = { authenticate } as never;
    return new ApiKeyGuard(reflector, svc);
  };

  describe('extractApiCredential', () => {
    it('reads a Bearer token', () => {
      expect(extractApiCredential({ headers: { authorization: 'Bearer pmk_a.secret' } })).toBe(
        'pmk_a.secret',
      );
    });
    it('reads X-Api-Key', () => {
      expect(extractApiCredential({ headers: { 'x-api-key': 'pmk_a.secret' } })).toBe('pmk_a.secret');
    });
    it('is undefined when neither header is present', () => {
      expect(extractApiCredential({ headers: {} })).toBeUndefined();
    });
  });

  it('401 when no credential is presented (authenticate not called)', async () => {
    const authenticate = jest.fn();
    const guard = guardWith(authenticate, ['documents:read']);
    await expect(guard.canActivate(makeContext({}).ctx)).rejects.toThrow(UnauthorizedException);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('401 when authenticate rejects the credential (invalid/disabled/revoked)', async () => {
    const authenticate = jest.fn().mockResolvedValue(null);
    const guard = guardWith(authenticate, ['documents:read']);
    await expect(
      guard.canActivate(makeContext({ authorization: 'Bearer pmk_x.bad' }).ctx),
    ).rejects.toThrow(UnauthorizedException);
    expect(authenticate).toHaveBeenCalledWith('pmk_x.bad');
  });

  it('403 when the client lacks a required scope', async () => {
    const authenticate = jest.fn().mockResolvedValue(client);
    const guard = guardWith(authenticate, ['download']); // client has no download scope
    await expect(
      guard.canActivate(makeContext({ 'x-api-key': 'pmk_a.secret' }).ctx),
    ).rejects.toThrow(ForbiddenException);
  });

  it('allows and attaches the client when scopes are satisfied', async () => {
    const authenticate = jest.fn().mockResolvedValue(client);
    const guard = guardWith(authenticate, ['documents:read']);
    const { ctx, req } = makeContext({ authorization: 'Bearer pmk_a.secret' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.apiClient).toEqual(client);
  });

  it('allows when a route requires no scope (still authenticated)', async () => {
    const authenticate = jest.fn().mockResolvedValue(client);
    const guard = guardWith(authenticate, undefined);
    const { ctx } = makeContext({ authorization: 'Bearer pmk_a.secret' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });
});
