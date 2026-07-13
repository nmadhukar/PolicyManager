import type {
  AccessLevel,
  DocumentDetail,
  DocumentListItem,
  DocumentSortField,
  DocumentStatus,
  DocumentVersionSummary,
  Paginated,
  ReviewCadence,
  SortOrder,
} from '@policymanager/shared';
import { http } from './http';

export type {
  DocumentDetail,
  DocumentListItem,
  DocumentVersionSummary,
  Paginated,
} from '@policymanager/shared';

/** Query parameters for the document library list. */
export interface DocumentListParams {
  q?: string;
  categoryId?: string;
  ownerId?: string;
  tag?: string;
  status?: DocumentStatus;
  accessLevel?: AccessLevel;
  reviewBefore?: string;
  reviewAfter?: string;
  page?: number;
  pageSize?: number;
  sort?: DocumentSortField;
  order?: SortOrder;
}

export interface CreateDocumentInput {
  title: string;
  documentNumber?: string;
  categoryId?: string;
  description?: string;
  tags?: string[];
  accessLevel?: AccessLevel;
  reviewCadence?: ReviewCadence;
  nextReviewDate?: string;
  effectiveDate?: string;
}

export interface UpdateDocumentInput {
  title?: string;
  documentNumber?: string;
  categoryId?: string | null;
  description?: string;
  tags?: string[];
  status?: DocumentStatus;
  accessLevel?: AccessLevel;
  reviewCadence?: ReviewCadence;
  nextReviewDate?: string | null;
  effectiveDate?: string | null;
}

export interface DownloadTicket {
  url: string;
  expiresIn: number;
  fileName: string;
}

/** Drops undefined/empty values so we don't send blank query params. */
function cleanParams(params: DocumentListParams): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') out[key] = value as string | number;
  }
  return out;
}

export async function listDocuments(
  params: DocumentListParams,
): Promise<Paginated<DocumentListItem>> {
  const { data } = await http.get<Paginated<DocumentListItem>>('/documents', {
    params: cleanParams(params),
  });
  return data;
}

export async function getDocument(id: string): Promise<DocumentDetail> {
  const { data } = await http.get<DocumentDetail>(`/documents/${id}`);
  return data;
}

export async function createDocument(input: CreateDocumentInput): Promise<DocumentDetail> {
  const { data } = await http.post<DocumentDetail>('/documents', input);
  return data;
}

export async function updateDocument(
  id: string,
  patch: UpdateDocumentInput,
): Promise<DocumentDetail> {
  const { data } = await http.patch<DocumentDetail>(`/documents/${id}`, patch);
  return data;
}

export async function uploadVersion(
  id: string,
  file: File,
  changeSummary?: string,
): Promise<DocumentVersionSummary> {
  const form = new FormData();
  form.append('file', file);
  if (changeSummary) form.append('changeSummary', changeSummary);
  const { data } = await http.post<DocumentVersionSummary>(`/documents/${id}/versions`, form);
  return data;
}

export async function getDownloadUrl(
  documentId: string,
  versionId: string,
): Promise<DownloadTicket> {
  const { data } = await http.get<DownloadTicket>(
    `/documents/${documentId}/versions/${versionId}/download`,
  );
  return data;
}
