import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { REVIEW_CADENCES, type DocumentDetail, type ReviewCadence } from '@policymanager/shared';
import { updateReviewSchedule } from '../api/documents';
import { assignReviewer, listReviewers, removeReviewer } from '../api/reviews';
import { listUsers } from '../api/users';
import { apiErrorMessage } from '../lib/apiError';
import { formatDate } from '../lib/format';
import { useToast } from '../ui/Toast';

/**
 * Reviewers panel on the document detail page (review.manage users). Shows the
 * cadence + next review date and lets a manager assign/unassign reviewers who will
 * receive review tasks when the document comes due. The API enforces review.manage.
 */
export function DocumentReviewersPanel({
  doc,
}: {
  doc: DocumentDetail;
}) {
  const queryClient = useQueryClient();
  const [editingSchedule, setEditingSchedule] = useState(false);
  const reviewersQuery = useQuery({
    queryKey: ['reviewers', doc.id],
    queryFn: () => listReviewers(doc.id),
    retry: false,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['reviewers', doc.id] });
  const reviewers = reviewersQuery.data ?? [];
  const forbidden = (reviewersQuery.error as AxiosError | null)?.response?.status === 403;

  return (
    <div className="card space-y-4 p-5">
      <div>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">Review schedule</h2>
          {!forbidden && (
            <button
              type="button"
              className="text-xs font-medium text-brand-600 hover:underline"
              onClick={() => setEditingSchedule((v) => !v)}
            >
              {editingSchedule ? 'Cancel' : 'Edit schedule'}
            </button>
          )}
        </div>
        <p className="mt-1 text-xs text-ink-muted">
          Reviewers are notified when this document comes due for QC review.
        </p>
      </div>

      {editingSchedule ? (
        <EditScheduleForm doc={doc} onDone={() => setEditingSchedule(false)} />
      ) : (
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-ink-muted">Cadence</dt>
            <dd className="font-medium text-ink">{doc.reviewCadence}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-ink-muted">Next review</dt>
            <dd className="font-medium text-ink">{formatDate(doc.nextReviewDate)}</dd>
          </div>
        </dl>
      )}

      <div className="border-t border-slate-100 pt-4">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">Reviewers</h3>
        {reviewersQuery.isLoading ? (
          <p className="text-sm text-ink-muted">Loading reviewers…</p>
        ) : forbidden ? (
          <p className="text-sm text-ink-muted">You don&apos;t have access to manage reviewers.</p>
        ) : reviewersQuery.isError ? (
          <p className="text-sm text-red-600">Couldn&apos;t load reviewers.</p>
        ) : reviewers.length === 0 ? (
          <p className="text-sm text-ink-muted">
            No reviewers assigned. When due, the review falls to the document owner.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {reviewers.map((r) => (
              <li
                key={r.userId}
                className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-sm"
              >
                <span
                  className="min-w-0 truncate"
                  title={r.email ? `${r.name ?? r.userId} · ${r.email}` : (r.name ?? r.userId)}
                >
                  <span className="font-medium text-ink">{r.name ?? r.userId}</span>
                  {r.email && <span className="text-ink-muted"> · {r.email}</span>}
                </span>
                <RemoveReviewerButton documentId={doc.id} userId={r.userId} onDone={invalidate} />
              </li>
            ))}
          </ul>
        )}
      </div>

      {!forbidden && <AddReviewerForm documentId={doc.id} onAdded={invalidate} />}
    </div>
  );
}

function EditScheduleForm({ doc, onDone }: { doc: DocumentDetail; onDone: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [reviewCadence, setReviewCadence] = useState<ReviewCadence>(doc.reviewCadence);
  const [nextReviewDate, setNextReviewDate] = useState(
    doc.nextReviewDate ? doc.nextReviewDate.slice(0, 10) : '',
  );
  const [error, setError] = useState<string | null>(null);
  const requiresDate = reviewCadence !== 'none';

  const mutation = useMutation({
    mutationFn: () =>
      updateReviewSchedule(doc.id, {
        reviewCadence,
        nextReviewDate: reviewCadence === 'none' ? null : nextReviewDate,
      }),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['document', doc.id] });
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      onDone();
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not update the review schedule.')),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (requiresDate && !nextReviewDate) {
      setError('Next review date is required.');
      return;
    }
    mutation.mutate();
  };

  return (
    <form className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3" onSubmit={submit}>
      {error && (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      )}
      <div>
        <label htmlFor="review-card-cadence" className="label">
          Cadence
        </label>
        <select
          id="review-card-cadence"
          className="input bg-white"
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
        <label htmlFor="review-card-next-date" className="label">
          Next review date
        </label>
        <input
          id="review-card-next-date"
          type="date"
          className="input bg-white"
          value={nextReviewDate}
          onChange={(e) => setNextReviewDate(e.target.value)}
          disabled={!requiresDate}
        />
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-secondary !py-1.5 text-sm" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="btn-primary !py-1.5 text-sm" disabled={mutation.isPending}>
          {mutation.isPending ? 'Saving...' : 'Save schedule'}
        </button>
      </div>
    </form>
  );
}

function RemoveReviewerButton({
  documentId,
  userId,
  onDone,
}: {
  documentId: string;
  userId: string;
  onDone: () => void;
}) {
  const toast = useToast();
  const mutation = useMutation({
    mutationFn: () => removeReviewer(documentId, userId),
    onSuccess: onDone,
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not remove the reviewer.')),
  });
  return (
    <button
      className="shrink-0 text-xs font-medium text-red-600 hover:underline"
      onClick={() => mutation.mutate()}
      disabled={mutation.isPending}
      aria-label="Remove reviewer"
    >
      {mutation.isPending ? '…' : 'Remove'}
    </button>
  );
}

function AddReviewerForm({ documentId, onAdded }: { documentId: string; onAdded: () => void }) {
  const [userId, setUserId] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Best-effort directory for the picker; falls back to a free-text id when the
  // caller lacks user.manage (the users list 403s).
  const usersQuery = useQuery({ queryKey: ['users'], queryFn: listUsers, retry: false });

  const mutation = useMutation({
    mutationFn: () => assignReviewer(documentId, userId.trim()),
    onSuccess: () => {
      setUserId('');
      setError(null);
      onAdded();
    },
    onError: (err) => {
      const status = (err as AxiosError).response?.status;
      setError(
        status === 400
          ? 'That user could not be found.'
          : status === 403
            ? 'You are not allowed to manage reviewers for this document.'
            : 'Could not add the reviewer. Please try again.',
      );
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!userId.trim()) {
      setError('Choose a user.');
      return;
    }
    mutation.mutate();
  };

  const userOptions = usersQuery.data ?? [];

  return (
    <form className="space-y-2 border-t border-slate-100 pt-4" onSubmit={onSubmit} aria-label="Add reviewer">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Add reviewer</h3>
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700" role="alert">
          {error}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {userOptions.length > 0 ? (
          <select
            aria-label="Reviewer"
            className="input min-w-[10rem] flex-1"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
          >
            <option value="">Select a user…</option>
            {userOptions.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.email})
              </option>
            ))}
          </select>
        ) : (
          <input
            aria-label="Reviewer user id"
            className="input min-w-[10rem] flex-1"
            placeholder="User id"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
          />
        )}
        <button type="submit" className="btn-primary !py-1.5 text-sm" disabled={mutation.isPending}>
          {mutation.isPending ? 'Adding…' : 'Add'}
        </button>
      </div>
    </form>
  );
}
