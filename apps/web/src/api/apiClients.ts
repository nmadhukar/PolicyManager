import type {
  ApiClientItem,
  ApiClientSecret,
  CreateApiClientInput,
  UpdateApiClientInput,
} from '@policymanager/shared';
import { http } from './http';

export type { ApiClientItem, ApiClientSecret } from '@policymanager/shared';

/** Lists all API clients (never the secret). */
export async function listApiClients(): Promise<ApiClientItem[]> {
  const { data } = await http.get<ApiClientItem[]>('/api-clients');
  return data;
}

/** Creates an API client; the response carries the plaintext secret ONCE. */
export async function createApiClient(input: CreateApiClientInput): Promise<ApiClientSecret> {
  const { data } = await http.post<ApiClientSecret>('/api-clients', input);
  return data;
}

/** Updates a client's scopes / allowed categories / enabled flag. */
export async function updateApiClient(
  id: string,
  input: UpdateApiClientInput,
): Promise<ApiClientItem> {
  const { data } = await http.patch<ApiClientItem>(`/api-clients/${id}`, input);
  return data;
}

/** Revokes a client (disables it; all future API calls fail). */
export async function revokeApiClient(id: string): Promise<ApiClientItem> {
  const { data } = await http.post<ApiClientItem>(`/api-clients/${id}/revoke`);
  return data;
}

/** Rotates the secret in place; the response carries the NEW plaintext secret ONCE. */
export async function rotateApiClientSecret(id: string): Promise<ApiClientSecret> {
  const { data } = await http.post<ApiClientSecret>(`/api-clients/${id}/rotate-secret`);
  return data;
}
