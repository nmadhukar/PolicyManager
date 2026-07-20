import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { REVIEW_CADENCES, type ReviewCadence } from '@policymanager/shared';
import {
  bulkUpdateReviewSchedule,
  type BulkReviewScheduleInput,
  type DocumentListParams,
} from '../../api/documents';
import { apiErrorMessage } from '../../lib/apiError';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { useToast } from '../../ui/Toast';

export function bulkScheduleFilters(
  params: DocumentListParams,
): NonNullable<BulkReviewScheduleInput['filters']> {
  const filterKeys: (keyof NonNullable<BulkReviewScheduleInput['filters']>)[] = [
    'q',
    'categoryId',
    'ownerId',
    'tag',
    'tags',
    'status',
    'accessLevel',
    'extractionStatus',
    'reviewBefore',
    'reviewAfter',
    'effectiveBefore',
    'effectiveAfter',
    'dueState',
    'includeArchived',
  ];
  const rest: Record<string, unknown> = {};
  for (const key of filterKeys) rest[key] = params[key];
  return Object.fromEntries(
    Object.entries(rest).filter(([, value]) => value !== undefined && value !== ''),
  ) as NonNullable<BulkReviewScheduleInput['filters']>;
}

export function BulkReviewSchedulePanel({
  selectedIds,
  totalMatching,
  filters,
  onDone,
}: {
  selectedIds: string[];
  totalMatching: number;
  filters: NonNullable<BulkReviewScheduleInput['filters']>;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [reviewCadence, setReviewCadence] = useState<ReviewCadence>('annual');
  const [nextReviewDate, setNextReviewDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pendingTarget, setPendingTarget] = useState<'selected' | 'filtered' | null>(null);
  const requiresDate = reviewCadence !== 'none';

  const mutation = useMutation({
    mutationFn: (input: BulkReviewScheduleInput) => bulkUpdateReviewSchedule(input),
    onSuccess: (result) => {
      setPendingTarget(null);
      setError(null);
      onDone();
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      toast.success(`Updated ${result.updated} review schedule${result.updated === 1 ? '' : 's'}.`);
    },
    onError: (err) => {
      setPendingTarget(null);
      toast.error(apiErrorMessage(err, 'Could not update review schedules.'));
    },
  });

  const validate = (): boolean => {
    if (requiresDate && !nextReviewDate) {
      setError('Next review date is required.');
      return false;
    }
    setError(null);
    return true;
  };

  const requestSubmit = (target: 'selected' | 'filtered') => {
    if (target === 'selected' && selectedIds.length === 0) {
      setError('Select at least one document.');
      return;
    }
    if (target === 'filtered' && totalMatching === 0) {
      setError('No matching documents.');
      return;
    }
    if (!validate()) return;
    setPendingTarget(target);
  };

  const confirm = () => {
    if (!pendingTarget) return;
    mutation.mutate({
      ...(pendingTarget === 'selected' ? { documentIds: selectedIds } : { filters }),
      reviewCadence,
      nextReviewDate: reviewCadence === 'none' ? null : nextReviewDate,
    });
  };

  const targetCount = pendingTarget === 'selected' ? selectedIds.length : totalMatching;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="grid gap-3 lg:grid-cols-[minmax(9rem,1fr)_minmax(9rem,1fr)_auto_auto] lg:items-end">
        <div>
          <label htmlFor="bulk-review-cadence" className="label">
            Bulk review cadence
          </label>
          <select
            id="bulk-review-cadence"
            className="input"
            value={reviewCadence}
            onChange={(e) => setReviewCadence(e.target.value as ReviewCadence)}
          >
            {REVIEW_CADENCES.map((cadence) => (
              <option key={cadence} value={cadence}>
                {cadence.charAt(0).toUpperCase() + cadence.slice(1)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="bulk-review-date" className="label">
            Next review date
          </label>
          <input
            id="bulk-review-date"
            type="date"
            className="input"
            value={nextReviewDate}
            onChange={(e) => setNextReviewDate(e.target.value)}
            disabled={!requiresDate}
          />
        </div>
        <button
          type="button"
          className="btn-secondary whitespace-nowrap"
          onClick={() => requestSubmit('selected')}
          disabled={selectedIds.length === 0 || mutation.isPending}
        >
          Schedule selected ({selectedIds.length})
        </button>
        <button
          type="button"
          className="btn-primary whitespace-nowrap"
          onClick={() => requestSubmit('filtered')}
          disabled={totalMatching === 0 || mutation.isPending}
        >
          Schedule filtered ({totalMatching})
        </button>
      </div>
      {error && (
        <p className="mt-2 text-sm text-red-600" role="alert">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={pendingTarget !== null}
        title="Apply review schedule?"
        body={
          <>
            This will update <span className="font-medium text-ink">{targetCount}</span>{' '}
            document{targetCount === 1 ? '' : 's'} to{' '}
            <span className="font-medium text-ink">{reviewCadence}</span>
            {reviewCadence === 'none' ? '.' : ` due ${nextReviewDate}.`}
          </>
        }
        confirmLabel="Apply schedule"
        busy={mutation.isPending}
        onConfirm={confirm}
        onCancel={() => setPendingTarget(null)}
      />
    </div>
  );
}
