import type { ApiScope } from '@policymanager/shared';

/**
 * The authenticated API client attached to a request by {@link ApiKeyGuard} and
 * read by the public controllers/service. Deliberately minimal — it carries only
 * what authorization + auditing need, never the secret hash.
 */
export interface AuthenticatedApiClient {
  id: string;
  name: string;
  scopes: ApiScope[];
  allowedCategoryIds: string[];
}
