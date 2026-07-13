import type {
  AcknowledgmentStatusSummary,
  ApproveDocumentInput,
  ApproveDocumentResult,
  AttestationItem,
  DistributeAcknowledgmentInput,
} from '@policymanager/shared';
import { http } from './http';

export type {
  AcknowledgmentStatusSummary,
  ApproveDocumentResult,
  AttestationItem,
} from '@policymanager/shared';

/** The document approval chain (reviewed/approved sign-offs, newest first). */
export async function listAttestations(documentId: string): Promise<AttestationItem[]> {
  const { data } = await http.get<AttestationItem[]>(`/documents/${documentId}/attestations`);
  return data;
}

/** Approve (or publish) a document — records an immutable approved sign-off. */
export async function approveDocument(
  documentId: string,
  input: ApproveDocumentInput,
): Promise<ApproveDocumentResult> {
  const { data } = await http.post<ApproveDocumentResult>(
    `/documents/${documentId}/approve`,
    input,
  );
  return data;
}

/** Distribute the current version to users/roles for acknowledgment. */
export async function distributeAcknowledgment(
  documentId: string,
  input: DistributeAcknowledgmentInput,
): Promise<AcknowledgmentStatusSummary> {
  const { data } = await http.post<AcknowledgmentStatusSummary>(
    `/documents/${documentId}/acknowledgments`,
    input,
  );
  return data;
}

/** Per-assignee acknowledgment status + completion % for the document (managers). */
export async function getAcknowledgmentStatus(
  documentId: string,
): Promise<AcknowledgmentStatusSummary> {
  const { data } = await http.get<AcknowledgmentStatusSummary>(
    `/documents/${documentId}/acknowledgments`,
  );
  return data;
}

/** Fetches the compliance cover-page PDF as a Blob (for preview/download). */
export async function fetchCoverPage(documentId: string): Promise<Blob> {
  const { data } = await http.get(`/documents/${documentId}/cover-page`, {
    responseType: 'blob',
  });
  return data as Blob;
}

/** Fetches the cover-prepended export PDF as a Blob (for download). */
export async function fetchExport(documentId: string): Promise<Blob> {
  const { data } = await http.get(`/documents/${documentId}/export`, {
    responseType: 'blob',
  });
  return data as Blob;
}
