import type {
  AccessLevel,
  DocumentDetail,
  DocumentListItem,
  DocumentSortField,
  DocumentStatus,
  DocumentVersionSummary,
  ExtractionStatus,
  Paginated,
  ReviewCadence,
  SortOrder,
  ViewTicket,
} from '@policymanager/shared';
import { http } from './http';

/** Result envelope of a text/OCR extraction run (single doc or full reindex). */
export interface ExtractionBatchResult {
  queued?: number;
  processed: number;
  done: number;
  skipped: number;
  failed: number;
}

export type {
  DocumentDetail,
  DocumentListItem,
  DocumentVersionSummary,
  Paginated,
  ViewTicket,
} from '@policymanager/shared';

/** Query parameters for the document library list. */
export interface DocumentListParams {
  q?: string;
  categoryId?: string;
  ownerId?: string;
  tag?: string;
  status?: DocumentStatus;
  accessLevel?: AccessLevel;
  /** Filter to documents whose current version has this extraction status. */
  extractionStatus?: ExtractionStatus;
  reviewBefore?: string;
  reviewAfter?: string;
  /** Trash view: only soft-deleted documents (requires document.write). */
  deleted?: boolean;
  /** Include archived documents in the active list. */
  includeArchived?: boolean;
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
  /** Reports upload progress 0–100 (only fires when total size is known). */
  onProgress?: (percent: number) => void,
): Promise<DocumentVersionSummary> {
  const form = new FormData();
  form.append('file', file);
  if (changeSummary) form.append('changeSummary', changeSummary);
  const { data } = await http.post<DocumentVersionSummary>(`/documents/${id}/versions`, form, {
    onUploadProgress: (e) => {
      if (onProgress && e.total) onProgress(Math.round((e.loaded / e.total) * 100));
    },
  });
  return data;
}

/**
 * Client-side hint of the file types the versioning + import flows accept, for
 * the `accept` attribute on file inputs. The API remains authoritative.
 */
export const UPLOAD_ACCEPT =
  '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.png,.jpg,.jpeg,.gif,.webp,image/*';

export async function getDownloadUrl(
  documentId: string,
  versionId: string,
): Promise<DownloadTicket> {
  const { data } = await http.get<DownloadTicket>(
    `/documents/${documentId}/versions/${versionId}/download`,
  );
  return data;
}

/** Soft-delete: moves the document to the trash (never destroys bytes). */
export async function softDeleteDocument(id: string): Promise<DocumentDetail> {
  const { data } = await http.delete<DocumentDetail>(`/documents/${id}`);
  return data;
}

/** Restore a soft-deleted document from the trash. */
export async function restoreDocument(id: string): Promise<DocumentDetail> {
  const { data } = await http.post<DocumentDetail>(`/documents/${id}/restore`);
  return data;
}

/** Archive: keeps the document accessible but out of active lists. */
export async function archiveDocument(id: string): Promise<DocumentDetail> {
  const { data } = await http.post<DocumentDetail>(`/documents/${id}/archive`);
  return data;
}

/** Unarchive: returns the document to its prior status/active lists. */
export async function unarchiveDocument(id: string): Promise<DocumentDetail> {
  const { data } = await http.post<DocumentDetail>(`/documents/${id}/unarchive`);
  return data;
}

/**
 * Restore an older version as a new current version. Copies the chosen version's
 * bytes to a new version and points the document at it; history is preserved.
 */
export async function restoreVersion(
  documentId: string,
  versionId: string,
): Promise<DocumentVersionSummary> {
  const { data } = await http.post<DocumentVersionSummary>(
    `/documents/${documentId}/versions/${versionId}/restore`,
  );
  return data;
}

// ---- Phase 3b: viewing + editing ----------------------------------------

/** Short-lived presigned URL for in-browser VIEWING (PDF rendition/PDF/image). */
export async function getViewUrl(
  documentId: string,
  versionId: string,
): Promise<ViewTicket> {
  const { data } = await http.get<ViewTicket>(
    `/documents/${documentId}/versions/${versionId}/view-url`,
  );
  return data;
}

/** Best-effort: (re)generate the PDF rendition for a version. */
export async function regenerateRendition(
  documentId: string,
  versionId: string,
): Promise<DocumentVersionSummary> {
  const { data } = await http.post<DocumentVersionSummary>(
    `/documents/${documentId}/versions/${versionId}/rendition`,
  );
  return data;
}

/** Re-run text/OCR extraction for one document (recover a failed/stuck scan). */
export async function retryExtraction(documentId: string): Promise<ExtractionBatchResult> {
  const { data } = await http.post<ExtractionBatchResult>(
    `/documents/${documentId}/extraction/retry`,
  );
  return data;
}

/** Signed OnlyOffice editor config for the current version (docx/xlsx/pptx). */
export async function getEditorConfig(documentId: string): Promise<Record<string, unknown>> {
  const { data } = await http.get<Record<string, unknown>>(
    `/documents/${documentId}/editor-config`,
  );
  return data;
}

/** Raw HTML of an app-authored (TipTap) text version, for loading into the editor. */
export async function getVersionHtml(
  documentId: string,
  versionId: string,
): Promise<{ html: string }> {
  const { data } = await http.get<{ html: string }>(
    `/documents/${documentId}/versions/${versionId}/html`,
  );
  return data;
}

/** Save an app-authored HTML document as a NEW immutable version (TipTap). */
export async function saveHtmlVersion(
  documentId: string,
  html: string,
  changeSummary?: string,
): Promise<DocumentVersionSummary> {
  const { data } = await http.post<DocumentVersionSummary>(
    `/documents/${documentId}/versions/html`,
    { html, changeSummary },
  );
  return data;
}
