import { Link } from 'react-router-dom';
import { PERMISSIONS } from '@policymanager/shared';
import { useAuth } from '../auth/AuthContext';
import { AppShell } from '../ui/AppShell';

export function DashboardPage() {
  const { user, hasPermission } = useAuth();
  const firstName = user?.name.split(' ')[0] ?? 'there';

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl">
        <h1 className="text-2xl font-semibold text-ink">Welcome back, {firstName}</h1>
        <p className="mt-2 text-ink-muted">
          A single, versioned, access-controlled home for your clinic&apos;s policies, procedures,
          job descriptions, and IOP/PHP curriculums — built for CARF and Joint Commission compliance.
        </p>

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <div className="card p-6">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
              Your access
            </h2>
            <dl className="mt-3 space-y-1 text-sm text-ink-soft">
              <div className="flex justify-between gap-4">
                <dt className="text-ink-muted">Signed in as</dt>
                <dd className="font-medium text-ink">{user?.email}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-ink-muted">Roles</dt>
                <dd className="text-right">{user?.roles.join(', ') || 'None'}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-ink-muted">Permissions</dt>
                <dd className="text-right">{user?.permissions.length ?? 0}</dd>
              </div>
            </dl>
          </div>

          {hasPermission(PERMISSIONS.DOCUMENT_READ) && (
            <div className="card p-6">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
                Documents
              </h2>
              <div className="mt-3 space-y-2 text-sm text-ink-soft">
                <p>Search, version, and manage your clinic&apos;s controlled documents.</p>
                <Link to="/library" className="btn-primary mt-2 inline-flex">
                  Open library
                </Link>
              </div>
            </div>
          )}

          <div className="card p-6">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
              Administration
            </h2>
            {hasPermission(PERMISSIONS.USER_MANAGE) ? (
              <div className="mt-3 space-y-2 text-sm text-ink-soft">
                <p>Manage who can access PolicyManager and what they can do.</p>
                <Link to="/admin/users" className="btn-primary mt-2 inline-flex">
                  Manage users
                </Link>
              </div>
            ) : (
              <p className="mt-3 text-sm text-ink-muted">
                Additional tools will appear here as your access allows.
              </p>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
