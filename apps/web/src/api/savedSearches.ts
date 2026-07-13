import type { SavedSearchItem, UpsertSavedSearchInput } from '@policymanager/shared';
import { http } from './http';

export async function listSavedSearches(): Promise<SavedSearchItem[]> {
  const { data } = await http.get<SavedSearchItem[]>('/saved-searches');
  return data;
}

export async function createSavedSearch(input: UpsertSavedSearchInput): Promise<SavedSearchItem> {
  const { data } = await http.post<SavedSearchItem>('/saved-searches', input);
  return data;
}

export async function updateSavedSearch(
  id: string,
  input: UpsertSavedSearchInput,
): Promise<SavedSearchItem> {
  const { data } = await http.patch<SavedSearchItem>(`/saved-searches/${id}`, input);
  return data;
}

export async function runSavedSearch(id: string): Promise<SavedSearchItem> {
  const { data } = await http.post<SavedSearchItem>(`/saved-searches/${id}/run`);
  return data;
}

export async function deleteSavedSearch(id: string): Promise<void> {
  await http.delete(`/saved-searches/${id}`);
}
