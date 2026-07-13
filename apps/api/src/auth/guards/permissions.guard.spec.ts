import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthUser } from '@policymanager/shared';
import { PermissionsGuard } from './permissions.guard';

describe('PermissionsGuard', () => {
  const makeContext = (user: AuthUser | undefined): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
      getHandler: () => () => undefined,
      getClass: () => class {},
    }) as unknown as ExecutionContext;

  const guardFor = (required: string[] | undefined) => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(required) } as unknown as Reflector;
    return new PermissionsGuard(reflector);
  };

  const staff: AuthUser = {
    id: 's', email: 's@x.com', name: 'Staff', roles: ['Staff'], permissions: ['document.read'],
    mustChangePassword: false,
  };
  const admin: AuthUser = {
    id: 'a', email: 'a@x.com', name: 'Admin', roles: ['Admin'],
    permissions: ['document.read', 'user.manage'], mustChangePassword: false,
  };

  it('allows when no permissions are required (auth-only route)', () => {
    expect(guardFor(undefined).canActivate(makeContext(staff))).toBe(true);
    expect(guardFor([]).canActivate(makeContext(staff))).toBe(true);
  });

  it('allows when the user holds the required permission (Admin -> user.manage)', () => {
    expect(guardFor(['user.manage']).canActivate(makeContext(admin))).toBe(true);
  });

  it('denies with 403 when the user lacks the permission (Staff -> user.manage)', () => {
    expect(() => guardFor(['user.manage']).canActivate(makeContext(staff))).toThrow(
      ForbiddenException,
    );
  });

  it('requires ALL permissions when multiple are declared (AND semantics)', () => {
    expect(() =>
      guardFor(['document.read', 'user.manage']).canActivate(makeContext(staff)),
    ).toThrow(ForbiddenException);
    expect(
      guardFor(['document.read', 'user.manage']).canActivate(makeContext(admin)),
    ).toBe(true);
  });

  it('throws 401 when there is no authenticated user', () => {
    expect(() => guardFor(['user.manage']).canActivate(makeContext(undefined))).toThrow(
      UnauthorizedException,
    );
  });
});
