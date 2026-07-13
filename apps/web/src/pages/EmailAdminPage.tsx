import { FormEvent, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { PERMISSIONS, type SmtpConfigView } from '@policymanager/shared';
import {
  getSmtpConfig,
  listNotifications,
  sendTestEmail,
  updateSmtpConfig,
} from '../api/smtp';
import { useAuth } from '../auth/AuthContext';
import { formatDateTime } from '../lib/format';
import { AppShell } from '../ui/AppShell';
import { EmptyState, ErrorState, ForbiddenState, LoadingState } from '../ui/states';

export function EmailAdminPage() {
  const { hasPermission } = useAuth();
  return (
    <AppShell>
      <div className="mx-auto max-w-5xl">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-ink">Email &amp; SMTP</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Configure the outbound mail server used for review reminders and account emails. The
            password is stored encrypted and never displayed.
          </p>
        </div>
        {/* UI gate is convenience only — the API enforces smtp.manage server-side. */}
        {hasPermission(PERMISSIONS.SMTP_MANAGE) ? <EmailManager /> : <ForbiddenState />}
      </div>
    </AppShell>
  );
}

function EmailManager() {
  const configQuery = useQuery({ queryKey: ['smtp-config'], queryFn: getSmtpConfig });
  const forbidden = (configQuery.error as AxiosError | null)?.response?.status === 403;

  if (configQuery.isLoading) return <LoadingState label="Loading email settings…" />;
  if (forbidden) return <ForbiddenState />;
  if (configQuery.isError || !configQuery.data) {
    return (
      <ErrorState
        description="We couldn't load the email settings."
        onRetry={() => void configQuery.refetch()}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <ConfigForm config={configQuery.data} />
        <TestEmailCard />
      </div>
      <NotificationsCard />
    </div>
  );
}

function ConfigForm({ config }: { config: SmtpConfigView }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    host: config.host,
    port: String(config.port),
    secure: config.secure,
    username: config.username ?? '',
    password: '',
    fromAddress: config.fromAddress,
    fromName: config.fromName,
    enabled: config.enabled,
  });
  const [changePassword, setChangePassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Re-sync when the server view changes (e.g., after a save round-trip).
  useEffect(() => {
    setForm({
      host: config.host,
      port: String(config.port),
      secure: config.secure,
      username: config.username ?? '',
      password: '',
      fromAddress: config.fromAddress,
      fromName: config.fromName,
      enabled: config.enabled,
    });
    setChangePassword(false);
  }, [config]);

  const mutation = useMutation({
    mutationFn: () =>
      updateSmtpConfig({
        host: form.host.trim(),
        port: Number(form.port),
        secure: form.secure,
        username: form.username.trim() || null,
        // Only send `password` when the admin chose to change it. Omitting it keeps
        // the stored one; an empty string (with the toggle on) clears it.
        ...(changePassword ? { password: form.password } : {}),
        fromAddress: form.fromAddress.trim(),
        fromName: form.fromName.trim(),
        enabled: form.enabled,
      }),
    onSuccess: () => {
      setSaved(true);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['smtp-config'] });
    },
    onError: () => setError('Could not save the settings. Please check the values and try again.'),
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    if (!form.host.trim() || !form.fromAddress.trim() || !form.fromName.trim()) {
      setError('Host, from address, and from name are required.');
      return;
    }
    const port = Number(form.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setError('Port must be a number between 1 and 65535.');
      return;
    }
    setError(null);
    mutation.mutate();
  };

  return (
    <form className="card space-y-4 p-5" onSubmit={onSubmit} aria-label="SMTP configuration">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">Server</h2>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            config.enabled ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-ink-soft'
          }`}
        >
          {config.enabled ? 'Enabled' : `Using ${config.source === 'db' ? 'saved' : 'env'} config`}
        </span>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </div>
      )}
      {saved && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700" role="status">
          Settings saved.
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label htmlFor="sm-host" className="label">
            Host
          </label>
          <input
            id="sm-host"
            className="input"
            value={form.host}
            onChange={(e) => setForm({ ...form, host: e.target.value })}
            placeholder="smtp.example.com"
          />
        </div>
        <div>
          <label htmlFor="sm-port" className="label">
            Port
          </label>
          <input
            id="sm-port"
            className="input"
            inputMode="numeric"
            value={form.port}
            onChange={(e) => setForm({ ...form, port: e.target.value })}
            placeholder="587"
          />
        </div>
        <div className="flex items-end">
          <label className="flex items-center gap-2 text-sm text-ink-soft">
            <input
              type="checkbox"
              checked={form.secure}
              onChange={(e) => setForm({ ...form, secure: e.target.checked })}
            />
            Use TLS (SMTPS)
          </label>
        </div>
        <div>
          <label htmlFor="sm-user" className="label">
            Username <span className="font-normal text-ink-muted">(optional)</span>
          </label>
          <input
            id="sm-user"
            className="input"
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            autoComplete="off"
          />
        </div>
        <div>
          <label htmlFor="sm-pass" className="label">
            Password
          </label>
          {!changePassword ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-ink-soft">
                {config.hasPassword ? '•••••••• (set)' : 'Not set'}
              </span>
              <button
                type="button"
                className="text-xs font-medium text-brand-600 hover:underline"
                onClick={() => setChangePassword(true)}
              >
                Change
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <input
                id="sm-pass"
                type="password"
                className="input"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                placeholder="New password (blank clears it)"
                autoComplete="new-password"
              />
              <button
                type="button"
                className="text-xs font-medium text-ink-muted hover:underline"
                onClick={() => {
                  setChangePassword(false);
                  setForm({ ...form, password: '' });
                }}
              >
                Keep
              </button>
            </div>
          )}
          <p className="mt-1 text-xs text-ink-muted">Stored encrypted; never displayed.</p>
        </div>
        <div>
          <label htmlFor="sm-from-addr" className="label">
            From address
          </label>
          <input
            id="sm-from-addr"
            className="input"
            value={form.fromAddress}
            onChange={(e) => setForm({ ...form, fromAddress: e.target.value })}
            placeholder="noreply@clinic.example"
          />
        </div>
        <div>
          <label htmlFor="sm-from-name" className="label">
            From name
          </label>
          <input
            id="sm-from-name"
            className="input"
            value={form.fromName}
            onChange={(e) => setForm({ ...form, fromName: e.target.value })}
            placeholder="PolicyManager"
          />
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm text-ink-soft">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
        />
        Use this configuration (otherwise the environment SMTP settings are used)
      </label>

      <div className="flex justify-end">
        <button type="submit" className="btn-primary" disabled={mutation.isPending}>
          {mutation.isPending ? 'Saving…' : 'Save settings'}
        </button>
      </div>
    </form>
  );
}

function TestEmailCard() {
  const [to, setTo] = useState('');
  const [result, setResult] = useState<'ok' | 'fail' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => sendTestEmail(to.trim()),
    onSuccess: (res) => {
      setResult(res.ok ? 'ok' : 'fail');
      setError(null);
    },
    onError: () => {
      setResult(null);
      setError('Could not send the test email.');
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setResult(null);
    if (!to.trim()) {
      setError('Enter a recipient email.');
      return;
    }
    setError(null);
    mutation.mutate();
  };

  return (
    <form className="card space-y-3 p-5" onSubmit={onSubmit} aria-label="Send test email">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">Test email</h2>
      <p className="text-sm text-ink-muted">
        Send a one-off message through the effective configuration to confirm delivery.
      </p>
      <div>
        <label htmlFor="te-to" className="label">
          Recipient
        </label>
        <input
          id="te-to"
          type="email"
          className="input"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="me@clinic.example"
        />
      </div>
      {error && (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      )}
      {result === 'ok' && (
        <p className="text-sm text-green-700" role="status">
          Test email sent. Check the inbox (or MailHog in development).
        </p>
      )}
      {result === 'fail' && (
        <p className="text-sm text-amber-700" role="status">
          The server accepted the request but reported the send failed. Check the log below.
        </p>
      )}
      <button type="submit" className="btn-secondary" disabled={mutation.isPending}>
        {mutation.isPending ? 'Sending…' : 'Send test email'}
      </button>
    </form>
  );
}

function NotificationsCard() {
  const query = useQuery({ queryKey: ['notifications'], queryFn: () => listNotifications({ pageSize: 25 }) });

  return (
    <div className="card p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
          Recent notifications
        </h2>
        <button
          className="text-xs font-medium text-brand-600 hover:underline"
          onClick={() => void query.refetch()}
        >
          Refresh
        </button>
      </div>
      {query.isLoading ? (
        <LoadingState label="Loading notifications…" />
      ) : query.isError ? (
        <ErrorState description="Couldn't load notifications." onRetry={() => void query.refetch()} />
      ) : (query.data?.items ?? []).length === 0 ? (
        <EmptyState title="No notifications yet" description="Sent emails will appear here." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-ink-muted">
              <tr>
                <th scope="col" className="py-2 pr-4 font-medium">When</th>
                <th scope="col" className="py-2 pr-4 font-medium">To</th>
                <th scope="col" className="py-2 pr-4 font-medium">Type</th>
                <th scope="col" className="py-2 pr-4 font-medium">Subject</th>
                <th scope="col" className="py-2 pr-0 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(query.data?.items ?? []).map((n) => (
                <tr key={n.id}>
                  <td className="py-2 pr-4 align-top text-ink-soft">{formatDateTime(n.createdAt)}</td>
                  <td className="py-2 pr-4 align-top text-ink-soft">{n.toEmail}</td>
                  <td className="py-2 pr-4 align-top text-ink-soft">{n.type}</td>
                  <td className="py-2 pr-4 align-top text-ink-soft">{n.subject}</td>
                  <td className="py-2 pr-0 align-top">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                        n.status === 'sent' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                      }`}
                      title={n.error ?? undefined}
                    >
                      {n.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
