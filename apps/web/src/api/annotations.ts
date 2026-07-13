import type {
  CreateAnnotationInput,
  DocumentAnnotationListResponse,
  DocumentAnnotationItem,
} from '@policymanager/shared';
import { http } from './http';

const path = (documentId: string, versionId: string) =>
  `/documents/${documentId}/versions/${versionId}/annotations`;

export async function listAnnotations(
  documentId: string,
  versionId: string,
): Promise<DocumentAnnotationListResponse> {
  const { data } = await http.get<DocumentAnnotationListResponse>(path(documentId, versionId));
  return data;
}

export async function createAnnotation(
  documentId: string,
  versionId: string,
  input: CreateAnnotationInput,
): Promise<DocumentAnnotationItem> {
  const { data } = await http.post<DocumentAnnotationItem>(path(documentId, versionId), input);
  return data;
}

export async function resolveAnnotation(
  documentId: string,
  versionId: string,
  annotationId: string,
): Promise<DocumentAnnotationItem> {
  const { data } = await http.post<DocumentAnnotationItem>(
    `${path(documentId, versionId)}/${annotationId}/resolve`,
  );
  return data;
}

export async function reopenAnnotation(
  documentId: string,
  versionId: string,
  annotationId: string,
): Promise<DocumentAnnotationItem> {
  const { data } = await http.post<DocumentAnnotationItem>(
    `${path(documentId, versionId)}/${annotationId}/reopen`,
  );
  return data;
}

export async function deleteAnnotation(
  documentId: string,
  versionId: string,
  annotationId: string,
): Promise<void> {
  await http.delete(`${path(documentId, versionId)}/${annotationId}`);
}
