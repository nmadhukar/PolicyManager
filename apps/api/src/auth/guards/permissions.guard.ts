import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthUser, PermissionKey } from '@policymanager/shared';
import { PERMISSIONS_KEY } from '../decorators/require-permission.decorator';

/**
 * Enforces @RequirePermission(...) metadata against the authenticated user's
 * resolved permission set.
 *
 * Contract (AGENTS.md §8):
 *  - No/invalid token (no request.user)      => 401 Unauthorized
 *  - Authenticated but missing permission      => 403 Forbidden
 *  - No @RequirePermission on the handler       => allowed (auth-only route)
 *
 * Must run AFTER JwtAuthGuard so request.user is populated.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<PermissionKey[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) {
      return true;
    }

    const user = context.switchToHttp().getRequest().user as AuthUser | undefined;
    if (!user) {
      // Defensive: PermissionsGuard should be paired with JwtAuthGuard.
      throw new UnauthorizedException();
    }

    const granted = new Set(user.permissions ?? []);
    const hasAll = required.every((key) => granted.has(key));
    if (!hasAll) {
      throw new ForbiddenException('Insufficient permissions');
    }
    return true;
  }
}
