import type { AuditEventItem, AuditSource, Paginated } from '@policymanager/shared';
import { http } from './http';

export type { AuditEventItem } from '@policymanager/shared';

/** Query parameters for the audit trail list. */
export interface AuditQueryParams {
  actorUserId?: string;
  documentId?: string;
  action?: string;
  source?: AuditSource;
  /** Inclusive lower bound (ISO date/time). */
  from?: string;
  /** Inclusive upper bound (ISO date/time). */
  to?: string;
  page?: number;
  pageSize?: number;
}

/** Drops undefined/empty values so we don't send blank query params. */
function cleanParams(params: AuditQueryParams): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') out[key] = value as string | number;
  }
  return out;
}

export async function listAudit(
  params: AuditQueryParams,
): Promise<Paginated<AuditEventItem>> {
  const { data } = await http.get<Paginated<AuditEventItem>>('/audit', {
    params: cleanParams(params),
  });
  return data;
}
