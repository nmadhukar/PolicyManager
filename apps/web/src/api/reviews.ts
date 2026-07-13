import type {
  ComplianceSummary,
  CompleteReviewInput,
  Paginated,
  ReviewSweepResult,
  ReviewTaskItem,
  ReviewTaskStatus,
  ReviewerAssignment,
} from '@policymanager/shared';
import { http } from './http';

export type {
  ComplianceSummary,
  Paginated,
  ReviewSweepResult,
  ReviewTaskItem,
  ReviewerAssignment,
} from '@policymanager/shared';

/** Query parameters for the review-task list. */
export interface ReviewListParams {
  assignedToId?: string;
  documentId?: string;
  status?: ReviewTaskStatus;
  dueFrom?: string;
  dueTo?: string;
  mine?: boolean;
  page?: number;
  pageSize?: number;
}

/** Drops undefined/empty values so we don't send blank query params. */
function clean(params: ReviewListParams): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      out[key] = value as string | number | boolean;
    }
  }
  return out;
}

/** Paginated review tasks (own tasks for non-managers; filterable for managers). */
export async function listReviewTasks(
  params: ReviewListParams,
): Promise<Paginated<ReviewTaskItem>> {
  const { data } = await http.get<Paginated<ReviewTaskItem>>('/reviews', { params: clean(params) });
  return data;
}

/** A single review task (own task unless the caller has review.manage). */
export async function getReviewTask(taskId: string): Promise<ReviewTaskItem> {
  const { data } = await http.get<ReviewTaskItem>(`/reviews/tasks/${taskId}`);
  return data;
}

/** Complete a review task; advances the document's next review date by cadence. */
export async function completeReview(
  taskId: string,
  input: CompleteReviewInput,
): Promise<ReviewTaskItem> {
  const { data } = await http.post<ReviewTaskItem>(`/reviews/${taskId}/complete`, input);
  return data;
}

/** Clinic-wide compliance snapshot (requires review.manage). */
export async function getComplianceSummary(): Promise<ComplianceSummary> {
  const { data } = await http.get<ComplianceSummary>('/reviews/compliance-summary');
  return data;
}

/** Run the review sweep now (requires review.manage). */
export async function runReviewSweep(): Promise<ReviewSweepResult> {
  const { data } = await http.post<ReviewSweepResult>('/reviews/run-sweep');
  return data;
}

// ---- Per-document reviewer assignment (requires review.manage) ------------

export async function listReviewers(documentId: string): Promise<ReviewerAssignment[]> {
  const { data } = await http.get<ReviewerAssignment[]>(`/documents/${documentId}/reviewers`);
  return data;
}

export async function assignReviewer(
  documentId: string,
  reviewerId: string,
): Promise<ReviewerAssignment> {
  const { data } = await http.post<ReviewerAssignment>(`/documents/${documentId}/reviewers`, {
    reviewerId,
  });
  return data;
}

export async function removeReviewer(documentId: string, userId: string): Promise<void> {
  await http.delete(`/documents/${documentId}/reviewers/${userId}`);
}
