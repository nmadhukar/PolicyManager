import type { EvidenceBinderOptions } from '@policymanager/shared';
import { http } from './http';

export interface EvidenceBinderHistoryItem {
  id: string;
  format: string;
  status: string;
  fileName: string;
  requestedByName: string | null;
  createdAt: string;
  completedAt: string | null;
}

export async function listEvidenceBinders(documentId: string): Promise<EvidenceBinderHistoryItem[]> {
  const { data } = await http.get<EvidenceBinderHistoryItem[]>(
    `/documents/${documentId}/evidence-binders`,
  );
  return data;
}

export async function exportEvidenceBinder(
  documentId: string,
  options: EvidenceBinderOptions,
): Promise<Blob> {
  const { data } = await http.post(`/documents/${documentId}/evidence-binders/export`, options, {
    responseType: 'blob',
  });
  return data as Blob;
}
