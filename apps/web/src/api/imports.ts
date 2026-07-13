import type {
  ImportBatchDetail,
  ImportBatchSummary,
  Paginated,
} from '@policymanager/shared';
import { http } from './http';

export type {
  ImportBatchDetail,
  ImportBatchSummary,
  ImportItemResult,
  ImportItemStatus,
} from '@policymanager/shared';

/** Uploads a CSV manifest plus the files it references; returns the import report. */
export async function runManifestImport(
  manifest: File,
  files: File[],
): Promise<ImportBatchDetail> {
  const form = new FormData();
  form.append('manifest', manifest);
  for (const file of files) form.append('files', file);
  const { data } = await http.post<ImportBatchDetail>('/imports', form);
  return data;
}

/**
 * Uploads files with no manifest; each becomes a document (dedupe by checksum).
 * `relativePaths`, when supplied by folder upload/drop, must align with `files`.
 */
export async function runBulkImport(
  files: File[],
  relativePaths?: string[],
): Promise<ImportBatchDetail> {
  const form = new FormData();
  for (const file of files) form.append('files', file);
  if (relativePaths && relativePaths.length > 0) {
    form.append('relativePaths', JSON.stringify(relativePaths));
  }
  const { data } = await http.post<ImportBatchDetail>('/imports/bulk', form);
  return data;
}

/** Lists past import batches (paginated, newest first). */
export async function listImportBatches(
  page = 1,
  pageSize = 20,
): Promise<Paginated<ImportBatchSummary>> {
  const { data } = await http.get<Paginated<ImportBatchSummary>>('/imports', {
    params: { page, pageSize },
  });
  return data;
}

/** Fetches one batch plus its full per-row report. */
export async function getImportBatch(id: string): Promise<ImportBatchDetail> {
  const { data } = await http.get<ImportBatchDetail>(`/imports/${id}`);
  return data;
}
