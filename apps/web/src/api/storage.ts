import type { StorageBucket, StorageConfigView, StoragePrefix } from '@policymanager/shared';
import { http } from './http';

export type { StorageBucket, StorageConfigView, StoragePrefix } from '@policymanager/shared';

/** Effective storage configuration (default bucket + prefixes). */
export async function getStorageConfig(): Promise<StorageConfigView> {
  const { data } = await http.get<StorageConfigView>('/storage/config');
  return data;
}

/** List all buckets. */
export async function listBuckets(): Promise<StorageBucket[]> {
  const { data } = await http.get<StorageBucket[]>('/storage/buckets');
  return data;
}

/** Create a private, versioned bucket. */
export async function createBucket(name: string): Promise<StorageBucket> {
  const { data } = await http.post<StorageBucket>('/storage/buckets', { name });
  return data;
}

/** List the immediate folders (prefixes) in a bucket. */
export async function listPrefixes(bucket: string, prefix?: string): Promise<StoragePrefix[]> {
  const { data } = await http.get<StoragePrefix[]>('/storage/prefixes', {
    params: { bucket, ...(prefix ? { prefix } : {}) },
  });
  return data;
}

/** Create a folder (prefix) marker in a bucket. */
export async function createPrefix(bucket: string, prefix: string): Promise<StoragePrefix> {
  const { data } = await http.post<StoragePrefix>('/storage/prefixes', { bucket, prefix });
  return data;
}
