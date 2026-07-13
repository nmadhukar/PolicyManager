import type { VersionCompareResult } from '@policymanager/shared';
import { http } from './http';

export async function compareVersions(
  documentId: string,
  fromVersionId: string,
  toVersionId: string,
): Promise<VersionCompareResult> {
  const { data } = await http.get<VersionCompareResult>(
    `/documents/${documentId}/versions/${fromVersionId}/compare/${toVersionId}`,
  );
  return data;
}

export async function fetchComparePdf(
  documentId: string,
  fromVersionId: string,
  toVersionId: string,
): Promise<Blob> {
  const { data } = await http.get(
    `/documents/${documentId}/versions/${fromVersionId}/compare/${toVersionId}/export`,
    { responseType: 'blob' },
  );
  return data as Blob;
}
