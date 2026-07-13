import { FormEvent, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import {
  PERMISSIONS,
  REVIEW_TASK_STATUS_LABELS,
  type ComplianceSummary,
  type ReviewTaskItem,
  type ReviewTaskStatus,
} from '@policymanager/shared';
import {
  completeReview,
  getComplianceSummary,
  listReviewTasks,
  runReviewSweep,
} from '../api/reviews';
import { useAuth } from '../auth/AuthContext';
import { apiErrorMessage } from '../lib/apiError';
import { formatDate } from '../lib/format';
import { AppShell } from '../ui/AppShell';
import { Modal } from '../ui/Modal';
import { EmptyState, ErrorState, LoadingState } from '../ui/states';
import { useToast } from '../ui/Toast';

/** Start-of-day (local) for a date, for calendar/day comparisons. */
function startOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}

/** Tailwind classes for a review-task status badge. */
function statusBadge(status: ReviewTaskStatus): string {
  switch (status) {
    case 'overdue':
      return 'bg-red-100 text-red-700';
    case 'completed':
      return 'bg-green-100 text-green-700';
    case 'in_progress':
      return 'bg-amber-100 text-amber-700';
    case 'cancelled':
      return 'bg-slate-200 text-ink-soft';
    default:
      return 'bg-slate-100 text-ink-soft';
  }
}

export function ReviewsPage() {
  return (
    <AppShell>
      <div className="mx-auto max-w-5xl">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-ink">Reviews</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Your QC review schedule — complete reviews to keep documents current for CARF and Joint
            Commission.
          </p>
        </div>
        <ReviewsDashboard />
      </div>
    </AppShell>
  );
}

function ReviewsDashboard() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission(PERMISSIONS.REVIEW_MANAGE);

  const tasksQuery = useQuery({
    queryKey: ['review-tasks', 'mine'],
    queryFn: () => listReviewTasks({ mine: true, pageSize: 200 }),
  });

  if (tasksQuery.isLoading) return <LoadingState label="Loading your reviews…" />;
  if (tasksQuery.isError) {
    return (
      <ErrorState description="We couldn't load your reviews." onRetry={() => void tasksQuery.refetch()} />
    );
  }

  const tasks = tasksQuery.data?.items ?? [];

  return (
    <div className="space-y-6">
      {canManage && <ComplianceCards />}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <MyReviews tasks={tasks} />
        </div>
        <div>
          <DueCalendar tasks={tasks} />
        </div>
      </div>
    </div>
  );
}

function ComplianceCards() {
  const query = useQuery({ queryKey: ['compliance-summary'], queryFn: getComplianceSummary });
  const queryClient = useQueryClient();
  const toast = useToast();
  const sweep = useMutation({
    mutationFn: runReviewSweep,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['compliance-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['review-tasks'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not run the review sweep.')),
  });

  const forbidden = (query.error as AxiosError | null)?.response?.status === 403;
  if (forbidden) return null; // Non-managers simply don't see the compliance panel.

  return (
    <section aria-label="Compliance summary" className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
          Compliance
        </h2>
        <button
          className="btn-secondary !py-1 text-xs"
          onClick={() => sweep.mutate()}
          disabled={sweep.isPending}
          title="Generate review tasks for documents coming due and flag overdue ones"
        >
          {sweep.isPending ? 'Running…' : 'Run review sweep'}
        </button>
      </div>
      {query.isLoading ? (
        <LoadingState label="Loading compliance…" />
      ) : query.isError ? (
        <ErrorState description="Couldn't load compliance." onRetry={() => void query.refetch()} />
      ) : (
        <ComplianceGrid summary={query.data as ComplianceSummary} />
      )}
      {sweep.isSuccess && (
        <p className="text-xs text-ink-muted" role="status">
          Sweep complete: {sweep.data.tasksCreated} task(s) created, {sweep.data.overdueMarked}{' '}
          marked overdue.
        </p>
      )}
    </section>
  );
}

function ComplianceGrid({ summary }: { summary: ComplianceSummary }) {
  const cards: { label: string; value: string | number; tone: string }[] = [
    { label: '% current', value: `${summary.percentCurrent}%`, tone: 'text-brand-700' },
    { label: 'Current', value: summary.current, tone: 'text-green-700' },
    { label: 'Due soon', value: summary.dueSoon, tone: 'text-amber-700' },
    { label: 'Overdue', value: summary.overdue, tone: 'text-red-700' },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {cards.map((c) => (
        <div key={c.label} className="card p-4">
          <div className={`text-2xl font-semibold ${c.tone}`}>{c.value}</div>
          <div className="mt-1 text-xs uppercase tracking-wide text-ink-muted">{c.label}</div>
        </div>
      ))}
      <div className="col-span-2 text-xs text-ink-muted sm:col-span-4">
        {summary.totalDocuments} in-force document{summary.totalDocuments === 1 ? '' : 's'} tracked.
      </div>
    </div>
  );
}

function MyReviews({ tasks }: { tasks: ReviewTaskItem[] }) {
  const today = startOfDay(new Date()).getTime();
  const soonCutoff = today + 14 * 24 * 60 * 60 * 1000;

  const open = tasks.filter((t) => t.status !== 'completed' && t.status !== 'cancelled');
  const overdue = open.filter(
    (t) => t.status === 'overdue' || startOfDay(new Date(t.dueDate)).getTime() < today,
  );
  const dueSoon = open.filter(
    (t) => !overdue.includes(t) && startOfDay(new Date(t.dueDate)).getTime() <= soonCutoff,
  );
  const upcoming = open.filter((t) => !overdue.includes(t) && !dueSoon.includes(t));
  const completed = tasks
    .filter((t) => t.status === 'completed')
    .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))
    .slice(0, 5);

  if (tasks.length === 0) {
    return (
      <EmptyState
        title="No reviews assigned to you"
        description="When a document you own or review comes due, a review task will appear here."
      />
    );
  }

  return (
    <div className="space-y-6">
      <TaskSection title="Overdue" tone="danger" tasks={overdue} />
      <TaskSection title="Due soon" tone="warn" tasks={dueSoon} />
      <TaskSection title="Upcoming" tone="neutral" tasks={upcoming} />
      {completed.length > 0 && <TaskSection title="Recently completed" tone="muted" tasks={completed} />}
    </div>
  );
}

function TaskSection({
  title,
  tone,
  tasks,
}: {
  title: string;
  tone: 'danger' | 'warn' | 'neutral' | 'muted';
  tasks: ReviewTaskItem[];
}) {
  const dot =
    tone === 'danger'
      ? 'bg-red-500'
      : tone === 'warn'
        ? 'bg-amber-500'
        : tone === 'muted'
          ? 'bg-slate-300'
          : 'bg-brand-500';

  return (
    <section aria-label={title} className="card p-5">
      <div className="mb-3 flex items-center gap-2">
        <span aria-hidden className={`h-2 w-2 rounded-full ${dot}`} />
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">{title}</h2>
        <span className="text-xs text-ink-muted">
          {tasks.length} task{tasks.length === 1 ? '' : 's'}
        </span>
      </div>
      {tasks.length === 0 ? (
        <p className="text-sm text-ink-muted">Nothing here.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {tasks.map((t) => (
            <TaskRow key={t.id} task={t} />
          ))}
        </ul>
      )}
    </section>
  );
}

function TaskRow({ task }: { task: ReviewTaskItem }) {
  const [open, setOpen] = useState(false);
  const closed = task.status === 'completed' || task.status === 'cancelled';

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-3">
      <div className="min-w-0">
        <Link to={`/library/${task.documentId}`} className="font-medium text-ink hover:underline">
          {task.documentTitle ?? 'Untitled document'}
        </Link>
        {task.documentNumber && (
          <span className="ml-2 text-xs text-ink-muted">{task.documentNumber}</span>
        )}
        <div className="mt-0.5 flex items-center gap-2 text-xs text-ink-muted">
          <span
            className={`inline-flex rounded-full px-2 py-0.5 font-medium ${statusBadge(task.status)}`}
          >
            {REVIEW_TASK_STATUS_LABELS[task.status]}
          </span>
          <span>Due {formatDate(task.dueDate)}</span>
          {task.completedAt && <span>· Completed {formatDate(task.completedAt)}</span>}
        </div>
      </div>
      {!closed && (
        <button className="btn-primary !py-1.5 text-sm" onClick={() => setOpen(true)}>
          Complete review
        </button>
      )}
      {open && <CompleteModal task={task} onClose={() => setOpen(false)} />}
    </li>
  );
}

/** Computes the auto-advanced next review date preview for quarterly/annual. */
function previewNextDate(cadence: ReviewTaskItem['reviewCadence']): string | null {
  const now = new Date();
  if (cadence === 'quarterly') {
    const d = new Date(now);
    d.setMonth(d.getMonth() + 3);
    return d.toISOString().slice(0, 10);
  }
  if (cadence === 'annual') {
    const d = new Date(now);
    d.setFullYear(d.getFullYear() + 1);
    return d.toISOString().slice(0, 10);
  }
  return null;
}

function CompleteModal({ task, onClose }: { task: ReviewTaskItem; onClose: () => void }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const requiresDate = task.reviewCadence === 'none' || task.reviewCadence === 'custom';
  const [notes, setNotes] = useState('');
  const [nextDate, setNextDate] = useState(requiresDate ? '' : (previewNextDate(task.reviewCadence) ?? ''));
  const [signatureName, setSignatureName] = useState(user?.name ?? '');
  const [signatureRole, setSignatureRole] = useState(user?.roles?.[0] ?? '');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      completeReview(task.id, {
        notes: notes.trim() || undefined,
        // Only send an explicit date when the user set one (override / required).
        newNextReviewDate: nextDate ? nextDate : undefined,
        // Sign-off signature captured on the immutable reviewed attestation.
        signatureName: signatureName.trim() || undefined,
        signatureRole: signatureRole.trim() || undefined,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['review-tasks'] });
      void queryClient.invalidateQueries({ queryKey: ['compliance-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['document', task.documentId] });
      onClose();
    },
    onError: (err) => {
      const status = (err as AxiosError).response?.status;
      setError(
        status === 400
          ? 'Please choose the next review date.'
          : status === 403
            ? 'You can only complete your own review tasks.'
            : 'Could not complete the review. Please try again.',
      );
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (requiresDate && !nextDate) {
      setError('This document uses a custom cadence — choose the next review date.');
      return;
    }
    if (!signatureName.trim()) {
      setError('Enter your name to sign off on this review.');
      return;
    }
    setError(null);
    mutation.mutate();
  };

  return (
    <Modal open onClose={onClose} titleId="complete-review-title" busy={mutation.isPending}>
      <form onSubmit={onSubmit} aria-label="Complete review">
        <h2 id="complete-review-title" className="text-base font-semibold text-ink">
          Complete review
        </h2>
        <p className="mt-1 text-sm text-ink-soft">{task.documentTitle}</p>

        {error && (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            {error}
          </div>
        )}

        <div className="mt-4">
          <label htmlFor="cr-notes" className="label">
            Notes <span className="font-normal text-ink-muted">(optional)</span>
          </label>
          <textarea
            id="cr-notes"
            className="input min-h-[80px]"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="What did you check? Any changes needed?"
          />
        </div>

        <div className="mt-3">
          <label htmlFor="cr-next" className="label">
            Next review date{' '}
            {requiresDate ? (
              <span className="text-red-600">*</span>
            ) : (
              <span className="font-normal text-ink-muted">(auto: {task.reviewCadence})</span>
            )}
          </label>
          <input
            id="cr-next"
            type="date"
            className="input"
            value={nextDate}
            onChange={(e) => setNextDate(e.target.value)}
            required={requiresDate}
          />
          {!requiresDate && (
            <p className="mt-1 text-xs text-ink-muted">
              Leave as-is to advance automatically by the {task.reviewCadence} cadence, or override.
            </p>
          )}
        </div>

        <div className="mt-4 border-t border-slate-100 pt-4">
          <p className="mb-2 text-xs text-ink-muted">
            Completing this review records an immutable sign-off (name, role, timestamp, IP) as
            compliance evidence.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="cr-sig" className="label">
                Signature (your name) <span className="text-red-600">*</span>
              </label>
              <input
                id="cr-sig"
                className="input"
                value={signatureName}
                onChange={(e) => setSignatureName(e.target.value)}
                required
              />
            </div>
            <div>
              <label htmlFor="cr-role" className="label">
                Role / title <span className="font-normal text-ink-muted">(optional)</span>
              </label>
              <input
                id="cr-role"
                className="input"
                value={signatureRole}
                onChange={(e) => setSignatureRole(e.target.value)}
              />
            </div>
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={mutation.isPending}>
            {mutation.isPending ? 'Completing…' : 'Complete review'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Minimal month calendar highlighting days that have review tasks due. */
function DueCalendar({ tasks }: { tasks: ReviewTaskItem[] }) {
  const [cursor, setCursor] = useState(() => startOfDay(new Date()));
  const year = cursor.getFullYear();
  const month = cursor.getMonth();

  const dueByDay = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of tasks) {
      if (t.status === 'completed' || t.status === 'cancelled') continue;
      const d = startOfDay(new Date(t.dueDate));
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }, [tasks]);

  const firstOfMonth = new Date(year, month, 1);
  const startWeekday = firstOfMonth.getDay(); // 0=Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayKey = (() => {
    const t = startOfDay(new Date());
    return `${t.getFullYear()}-${t.getMonth()}-${t.getDate()}`;
  })();

  const cells: (number | null)[] = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const monthLabel = firstOfMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  return (
    <div className="card p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">Due dates</h2>
        <div className="flex items-center gap-1">
          <button
            className="rounded px-2 py-1 text-sm text-ink-soft hover:bg-slate-100"
            aria-label="Previous month"
            onClick={() => setCursor(new Date(year, month - 1, 1))}
          >
            ‹
          </button>
          <button
            className="rounded px-2 py-1 text-sm text-ink-soft hover:bg-slate-100"
            aria-label="Next month"
            onClick={() => setCursor(new Date(year, month + 1, 1))}
          >
            ›
          </button>
        </div>
      </div>
      <div className="mb-2 text-center text-sm font-medium text-ink">{monthLabel}</div>
      <div className="grid grid-cols-7 gap-1 text-center text-[10px] uppercase text-ink-muted">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
          <div key={i}>{d}</div>
        ))}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {cells.map((day, i) => {
          if (day === null) return <div key={`e-${i}`} />;
          const key = `${year}-${month}-${day}`;
          const count = dueByDay.get(key) ?? 0;
          const isToday = key === todayKey;
          return (
            <div
              key={key}
              className={`relative grid h-9 place-items-center rounded text-sm ${
                isToday ? 'ring-1 ring-brand-400' : ''
              } ${count > 0 ? 'bg-brand-50 font-semibold text-brand-700' : 'text-ink-soft'}`}
              title={count > 0 ? `${count} review${count === 1 ? '' : 's'} due` : undefined}
            >
              {day}
              {count > 0 && (
                <span
                  aria-hidden
                  className="absolute bottom-1 h-1 w-1 rounded-full bg-brand-500"
                />
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-ink-muted">
        Highlighted days have reviews due. Use ‹ › to change month.
      </p>
    </div>
  );
}
