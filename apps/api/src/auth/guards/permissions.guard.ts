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
 *  - mustChangePassword=true on the user       => 403 Forbidden (server-side
 *    backstop; the SPA already redirects to /change-password client-side, but
 *    that is UX routing, not a security boundary — a script/curl caller must
 *    also be blocked from using a temporary, admin-issued credential for
 *    anything other than setting a real password). Routes that are reachable
 *    with a temporary password (change-password, me) apply only JwtAuthGuard
 *    in AuthController, never this guard, so they are unaffected.
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

    const user = context.switchToHttp().getRequest().user as AuthUser | undefined;

    if (!required || required.length === 0) {
      // Auth-only route (no specific permission required). Still block a
      // temporary password from reaching it, mirroring the permission-gated
      // path below.
      if (user?.mustChangePassword) {
        throw new ForbiddenException('You must change your password before continuing');
      }
      return true;
    }

    if (!user) {
      // Defensive: PermissionsGuard should be paired with JwtAuthGuard.
      throw new UnauthorizedException();
    }

    if (user.mustChangePassword) {
      throw new ForbiddenException('You must change your password before continuing');
    }

    const granted = new Set(user.permissions ?? []);
    const hasAll = required.every((key) => granted.has(key));
    if (!hasAll) {
      throw new ForbiddenException('Insufficient permissions');
    }
    return true;
  }
}
