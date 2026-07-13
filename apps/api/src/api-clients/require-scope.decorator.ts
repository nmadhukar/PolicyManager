import { SetMetadata } from '@nestjs/common';
import type { ApiScope } from '@policymanager/shared';

export const API_SCOPES_KEY = 'requiredApiScopes';

/**
 * Declares the API scope(s) a public route requires. Enforced by {@link ApiKeyGuard}.
 * When multiple are given the client must hold ALL of them (AND semantics).
 * Server-side authorization only — never a UI/client concern (AGENTS.md §8).
 */
export const RequireScope = (...scopes: ApiScope[]) => SetMetadata(API_SCOPES_KEY, scopes);
