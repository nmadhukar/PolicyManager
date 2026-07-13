import type {
  AcknowledgeInput,
  AttestationItem,
  MyAcknowledgmentItem,
} from '@policymanager/shared';
import { http } from './http';

export type { MyAcknowledgmentItem } from '@policymanager/shared';

/** Result of acknowledging an assignment. */
export interface AcknowledgeResult {
  assignment: MyAcknowledgmentItem;
  attestation: AttestationItem;
}

/** My acknowledgment assignments (pending/overdue first, then completed). */
export async function listMyAcknowledgments(): Promise<MyAcknowledgmentItem[]> {
  const { data } = await http.get<MyAcknowledgmentItem[]>('/acknowledgments', {
    params: { mine: true },
  });
  return data;
}

/** Acknowledge (read & understand) an assignment — records an immutable sign-off. */
export async function acknowledge(
  assignmentId: string,
  input: AcknowledgeInput,
): Promise<AcknowledgeResult> {
  const { data } = await http.post<AcknowledgeResult>(
    `/acknowledgments/${assignmentId}/acknowledge`,
    input,
  );
  return data;
}
