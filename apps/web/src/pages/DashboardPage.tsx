import { Link } from 'react-router-dom';
import { PERMISSIONS, type PermissionKey } from '@policymanager/shared';
import { useAuth } from '../auth/AuthContext';
import { AppShell } from '../ui/AppShell';

interface DashboardAction {
  title: string;
  description: string;
  to: string;
  label: string;
  requires?: PermissionKey;
}

const ACTIONS: DashboardAction[] = [
  {
    title: 'Document library',
    description: 'Search, create, version, archive, and restore controlled documents.',
    to: '/library',
    label: 'Open library',
    requires: PERMISSIONS.DOCUMENT_READ,
  },
  {
    title: 'Import documents',
    description: 'Bulk onboard scattered policies with duplicate detection and import reports.',
    to: '/library/import',
    label: 'Run import',
    requires: PERMISSIONS.DOCUMENT_WRITE,
  },
  {
    title: 'Reviews',
    description: 'Complete assigned QC reviews and monitor upcoming due dates.',
    to: '/reviews',
    label: 'View reviews',
  },
  {
    title: 'Acknowledgments',
    description: 'Read and sign documents assigned to you for staff acknowledgment.',
    to: '/acknowledgments',
    label: 'View acknowledgments',
  },
  {
    title: 'Users and roles',
    description: 'Manage accounts, role assignments, lockouts, and password resets.',
    to: '/admin/users',
    label: 'Manage users',
    requires: PERMISSIONS.USER_MANAGE,
  },
  {
    title: 'Audit log',
    description: 'Review document access, security events, API reads, and admin actions.',
    to: '/admin/audit',
    label: 'Open audit log',
    requires: PERMISSIONS.AUDIT_READ,
  },
  {
    title: 'Storage',
    description: 'Review S3/MinIO configuration and create private buckets or prefixes.',
    to: '/admin/storage',
    label: 'Manage storage',
    requires: PERMISSIONS.STORAGE_MANAGE,
  },
  {
    title: 'Email',
    description: 'Configure SMTP, send test email, and inspect notification delivery.',
    to: '/admin/email',
    label: 'Manage email',
    requires: PERMISSIONS.SMTP_MANAGE,
  },
  {
    title: 'API clients',
    description: 'Create scoped read-only keys for EMR or AI ingestion integrations.',
    to: '/admin/api-clients',
    label: 'Manage API clients',
    requires: PERMISSIONS.API_MANAGE,
  },
];

export function DashboardPage() {
  const { user, hasPermission } = useAuth();
  const firstName = user?.name.split(' ')[0] ?? 'there';
  const visibleActions = ACTIONS.filter(
    (action) => !action.requires || hasPermission(action.requires),
  );

  return (
    <AppShell>
      <div className="mx-auto max-w-6xl">
        <h1 className="text-2xl font-semibold text-ink">Welcome back, {firstName}</h1>
        <p className="mt-2 text-ink-muted">
          A single, versioned, access-controlled home for your clinic&apos;s policies, procedures,
          job descriptions, and IOP/PHP curriculums.
        </p>

        <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Available modules">
            {visibleActions.map((action) => (
              <div key={action.to} className="card flex min-h-44 flex-col p-5">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
                  {action.title}
                </h2>
                <p className="mt-3 flex-1 text-sm text-ink-soft">{action.description}</p>
                <Link to={action.to} className="btn-primary mt-4 inline-flex self-start">
                  {action.label}
                </Link>
              </div>
            ))}
          </section>

          <aside className="card h-fit p-6">
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
            {visibleActions.length === 0 && (
              <p className="mt-4 text-sm text-ink-muted">
                No modules are currently available for your role.
              </p>
            )}
          </aside>
        </div>
      </div>
    </AppShell>
  );
}
