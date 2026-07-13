import { SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '@policymanager/shared';

export const PERMISSIONS_KEY = 'requiredPermissions';

/**
 * Declares the permission key(s) a route requires. Enforced by PermissionsGuard.
 * When multiple keys are given, the caller must hold ALL of them (AND semantics).
 *
 * Server-side authorization only — UI hiding is never security (AGENTS.md §8).
 */
export const RequirePermission = (...keys: PermissionKey[]) =>
  SetMetadata(PERMISSIONS_KEY, keys);
