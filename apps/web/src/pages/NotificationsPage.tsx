import { FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  APP_NOTIFICATION_LABELS,
  NOTIFICATION_DIGEST_FREQUENCIES,
  type NotificationDigestFrequency,
} from '@policymanager/shared';
import {
  dismissNotification,
  getNotificationPreferences,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  updateNotificationPreferences,
} from '../api/notifications';
import { apiErrorMessage } from '../lib/apiError';
import { formatDateTime } from '../lib/format';
import { AppShell } from '../ui/AppShell';
import { EmptyState, ErrorState, LoadingState } from '../ui/states';
import { useToast } from '../ui/Toast';

export function NotificationsPage() {
  return (
    <AppShell>
      <div className="mx-auto max-w-4xl space-y-6">
        <header>
          <h1 className="text-2xl font-semibold text-ink">Notifications</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Reviews, acknowledgments, approvals, policy publications, and resolved comments.
          </p>
        </header>
        <NotificationList />
        <NotificationPreferences />
      </div>
    </AppShell>
  );
}

function NotificationList() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const query = useQuery({
    queryKey: ['notifications', unreadOnly],
    queryFn: () => listNotifications({ unreadOnly, pageSize: 50 }),
  });
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    void queryClient.invalidateQueries({ queryKey: ['notification-unread-count'] });
  };
  const markRead = useMutation({
    mutationFn: markNotificationRead,
    onSuccess: invalidate,
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not mark notification read.')),
  });
  const dismiss = useMutation({
    mutationFn: dismissNotification,
    onSuccess: invalidate,
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not dismiss notification.')),
  });
  const readAll = useMutation({
    mutationFn: markAllNotificationsRead,
    onSuccess: invalidate,
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not mark notifications read.')),
  });

  return (
    <section className="space-y-3" aria-label="Notification center">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5">
          <button
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${!unreadOnly ? 'bg-brand-600 text-white' : 'text-ink-soft'}`}
            onClick={() => setUnreadOnly(false)}
          >
            All
          </button>
          <button
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${unreadOnly ? 'bg-brand-600 text-white' : 'text-ink-soft'}`}
            onClick={() => setUnreadOnly(true)}
          >
            Unread
          </button>
        </div>
        <button
          className="btn-secondary !py-1.5 text-sm"
          onClick={() => readAll.mutate()}
          disabled={readAll.isPending}
        >
          Mark all read
        </button>
      </div>

      {query.isLoading ? (
        <LoadingState label="Loading notifications..." />
      ) : query.isError ? (
        <ErrorState description="Could not load notifications." onRetry={() => void query.refetch()} />
      ) : (query.data?.items.length ?? 0) === 0 ? (
        <EmptyState title="No notifications" description="Actionable policy updates appear here." />
      ) : (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
          {query.data!.items.map((item) => (
            <li key={item.id} className={`p-4 ${item.readAt ? '' : 'bg-brand-50/30'}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                    {APP_NOTIFICATION_LABELS[item.type]}
                  </div>
                  <div className="mt-1 font-medium text-ink">{item.title}</div>
                  <p className="mt-1 text-sm text-ink-soft">{item.body}</p>
                  <div className="mt-1 text-xs text-ink-muted">
                    {formatDateTime(item.createdAt)}
                    {item.actorName ? ` by ${item.actorName}` : ''}
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  {item.href && (
                    <Link className="btn-secondary !py-1 text-xs" to={item.href}>
                      Open
                    </Link>
                  )}
                  {!item.readAt && (
                    <button
                      className="btn-secondary !py-1 text-xs"
                      onClick={() => markRead.mutate(item.id)}
                      disabled={markRead.isPending}
                    >
                      Read
                    </button>
                  )}
                  <button
                    className="btn-secondary !py-1 text-xs"
                    onClick={() => dismiss.mutate(item.id)}
                    disabled={dismiss.isPending}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function NotificationPreferences() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const query = useQuery({
    queryKey: ['notification-preferences'],
    queryFn: getNotificationPreferences,
  });
  const [digestEnabled, setDigestEnabled] = useState(false);
  const [frequency, setFrequency] = useState<NotificationDigestFrequency>('daily');
  const [time, setTime] = useState('08:00');
  const [timezone, setTimezone] = useState('America/New_York');

  const mutation = useMutation({
    mutationFn: () =>
      updateNotificationPreferences({
        emailDigestEnabled: digestEnabled,
        digestFrequency: frequency,
        digestTimeLocal: time,
        timezone,
      }),
    onSuccess: () => {
      toast.success('Notification preferences saved.');
      void queryClient.invalidateQueries({ queryKey: ['notification-preferences'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not save preferences.')),
  });

  useEffect(() => {
    if (!query.data) return;
    setDigestEnabled(query.data.emailDigestEnabled);
    setFrequency(query.data.digestFrequency);
    setTime(query.data.digestTimeLocal);
    setTimezone(query.data.timezone);
  }, [query.data]);

  if (query.isLoading) {
    return <LoadingState label="Loading notification preferences..." />;
  }
  if (query.isError) {
    return (
      <ErrorState
        description="Could not load notification preferences."
        onRetry={() => void query.refetch()}
      />
    );
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    mutation.mutate();
  };

  return (
    <form className="card space-y-4 p-5" onSubmit={onSubmit} aria-label="Notification preferences">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
        Email digest
      </h2>
      <label className="flex items-center gap-2 text-sm text-ink-soft">
        <input
          type="checkbox"
          checked={digestEnabled}
          onChange={(e) => setDigestEnabled(e.target.checked)}
        />
        Send me an email digest
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor="digest-frequency" className="label">
            Frequency
          </label>
          <select
            id="digest-frequency"
            className="input"
            value={frequency}
            onChange={(e) => setFrequency(e.target.value as NotificationDigestFrequency)}
          >
            {NOTIFICATION_DIGEST_FREQUENCIES.map((f) => (
              <option key={f} value={f}>
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="digest-time" className="label">
            Time
          </label>
          <input
            id="digest-time"
            className="input"
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="digest-zone" className="label">
            Timezone
          </label>
          <input
            id="digest-zone"
            className="input"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
          />
        </div>
      </div>
      <div className="flex justify-end">
        <button className="btn-primary" disabled={mutation.isPending}>
          {mutation.isPending ? 'Saving...' : 'Save preferences'}
        </button>
      </div>
    </form>
  );
}
