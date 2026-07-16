import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import {
  ACK_STATUS_LABELS,
  ROLES,
  type AckStatus,
  type DocumentDetail,
} from '@policymanager/shared';
import { distributeAcknowledgment, getAcknowledgmentStatus } from '../api/signoff';
import { listUsers } from '../api/users';
import { formatDate } from '../lib/format';

/** Badge classes per acknowledgment status. */
function ackBadge(status: AckStatus): string {
  switch (status) {
    case 'completed':
      return 'bg-green-100 text-green-700';
    case 'overdue':
      return 'bg-red-100 text-red-700';
    case 'cancelled':
      return 'bg-slate-200 text-ink-soft';
    default:
      return 'bg-amber-100 text-amber-700';
  }
}

/**
 * Acknowledgment distribution panel (review.manage). Distributes the current
 * version to selected roles/users and shows per-assignee completion. The API
 * enforces review.manage; a new version re-triggers acknowledgment on publish.
 */
export function DocumentAcknowledgmentPanel({
  doc,
  bare = false,
}: {
  doc: DocumentDetail;
  bare?: boolean;
}) {
  const statusQuery = useQuery({
    queryKey: ['ack-status', doc.id],
    queryFn: () => getAcknowledgmentStatus(doc.id),
    retry: false,
  });
  const forbidden = (statusQuery.error as AxiosError | null)?.response?.status === 403;
  const summary = statusQuery.data;

  // In bare mode the SectionCard supplies the icon + 'Staff acknowledgment'
  // title + subtitle, so the leading header block renders only in full mode.
  const body = (
    <>
      {!bare && (
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
            Staff acknowledgment
          </h2>
          <p className="mt-1 text-xs text-ink-muted">
            Distribute the current version for staff to read &amp; sign.
          </p>
        </div>
      )}

      {forbidden ? (
        <p className="text-sm text-ink-muted">You don&apos;t have access to manage acknowledgments.</p>
      ) : statusQuery.isLoading ? (
        <p className="text-sm text-ink-muted">Loading status…</p>
      ) : statusQuery.isError ? (
        <p className="text-sm text-red-600">Couldn&apos;t load acknowledgment status.</p>
      ) : summary && summary.total > 0 ? (
        <div className="space-y-3 border-t border-slate-100 pt-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-ink-muted">
              Completion{summary.versionNumber != null ? ` · v${summary.versionNumber}` : ''}
            </span>
            <span className="font-semibold text-ink">
              {summary.completed}/{summary.total} ({summary.percentComplete}%)
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-brand-500"
              style={{ width: `${summary.percentComplete}%` }}
              aria-hidden
            />
          </div>
          <ul className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
            {summary.rows.map((r) => (
              <li
                key={r.assignmentId}
                className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-sm"
              >
                <span className="min-w-0 truncate">
                  <span className="font-medium text-ink">{r.assigneeName ?? r.assigneeId}</span>
                  {r.completedAt && (
                    <span className="text-ink-muted"> · {formatDate(r.completedAt)}</span>
                  )}
                </span>
                <span
                  className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${ackBadge(r.status)}`}
                >
                  {ACK_STATUS_LABELS[r.status]}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="border-t border-slate-100 pt-3 text-sm text-ink-muted">
          Not yet distributed for acknowledgment.
        </p>
      )}

      {!forbidden && <DistributeForm doc={doc} />}
    </>
  );

  if (bare) return <div className="space-y-4">{body}</div>;
  return <div className="card space-y-4 p-5">{body}</div>;
}

function DistributeForm({ doc }: { doc: DocumentDetail }) {
  const queryClient = useQueryClient();
  const [roleNames, setRoleNames] = useState<string[]>([]);
  const [userIds, setUserIds] = useState<string[]>([]);
  const [dueDate, setDueDate] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Best-effort user directory (403 for review.manage-only users → role-only mode).
  const usersQuery = useQuery({ queryKey: ['users'], queryFn: listUsers, retry: false });
  const users = usersQuery.data ?? [];

  const mutation = useMutation({
    mutationFn: () =>
      distributeAcknowledgment(doc.id, {
        roleNames: roleNames.length ? roleNames : undefined,
        assigneeIds: userIds.length ? userIds : undefined,
        dueDate: dueDate || undefined,
      }),
    onSuccess: () => {
      setRoleNames([]);
      setUserIds([]);
      setDueDate('');
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['ack-status', doc.id] });
    },
    onError: (err) => {
      const status = (err as AxiosError).response?.status;
      setError(
        status === 400
          ? 'Choose at least one role or user, and make sure the document has a current version.'
          : status === 403
            ? 'You are not allowed to distribute this document.'
            : 'Could not distribute. Please try again.',
      );
    },
  });

  const toggle = (list: string[], value: string): string[] =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (roleNames.length === 0 && userIds.length === 0) {
      setError('Select at least one role or user.');
      return;
    }
    setError(null);
    mutation.mutate();
  };

  return (
    <form className="space-y-3 border-t border-slate-100 pt-4" onSubmit={onSubmit} aria-label="Distribute for acknowledgment">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
        Distribute for acknowledgment
      </h3>
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700" role="alert">
          {error}
        </div>
      )}

      <fieldset>
        <legend className="mb-1 text-xs text-ink-muted">Roles (all members)</legend>
        <div className="flex flex-wrap gap-1.5">
          {Object.values(ROLES).map((role) => (
            <label
              key={role}
              className={`cursor-pointer rounded-full border px-2.5 py-0.5 text-xs focus-within:ring-2 focus-within:ring-brand-400 focus-within:ring-offset-2 ${
                roleNames.includes(role)
                  ? 'border-brand-500 bg-brand-50 text-brand-700'
                  : 'border-slate-200 text-ink-soft'
              }`}
            >
              <input
                type="checkbox"
                className="sr-only"
                checked={roleNames.includes(role)}
                onChange={() => setRoleNames((r) => toggle(r, role))}
              />
              {role}
            </label>
          ))}
        </div>
      </fieldset>

      {users.length > 0 && (
        <fieldset>
          <legend className="mb-1 text-xs text-ink-muted">Individual users</legend>
          <div className="max-h-32 space-y-1 overflow-y-auto overflow-x-hidden rounded-lg border border-slate-200 p-2">
            {users.map((u) => (
              <label
                key={u.id}
                className="flex min-w-0 items-center gap-2 text-xs text-ink-soft"
                title={`${u.name} (${u.email})`}
              >
                <input
                  type="checkbox"
                  className="shrink-0"
                  checked={userIds.includes(u.id)}
                  onChange={() => setUserIds((ids) => toggle(ids, u.id))}
                />
                <span className="min-w-0 truncate">
                  {u.name} <span className="text-ink-muted">({u.email})</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <div>
        <label htmlFor="dist-due" className="label">
          Due date <span className="font-normal text-ink-muted">(optional)</span>
        </label>
        <input
          id="dist-due"
          type="date"
          className="input"
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
        />
      </div>

      <button type="submit" className="btn-primary !py-1.5 text-sm" disabled={mutation.isPending}>
        {mutation.isPending ? 'Distributing…' : 'Distribute'}
      </button>
    </form>
  );
}
