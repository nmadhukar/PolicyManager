import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import {
  AUDIT_ACTION_LABELS,
  AUDIT_ACTION_VALUES,
  AUDIT_SOURCES,
  PERMISSIONS,
  type AuditEventItem,
  type AuditSource,
} from '@policymanager/shared';
import { AuditQueryParams, listAudit } from '../api/audit';
import { useAuth } from '../auth/AuthContext';
import { useDebouncedValue } from '../lib/useDebouncedValue';
import { formatDateTime } from '../lib/format';
import { AppShell } from '../ui/AppShell';
import { EmptyState, ErrorState, ForbiddenState, LoadingState } from '../ui/states';

const PAGE_SIZE = 25;

interface Filters {
  action: string;
  source: string;
  documentId: string;
  actorUserId: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: Filters = {
  action: '',
  source: '',
  documentId: '',
  actorUserId: '',
  from: '',
  to: '',
};

/** Friendly label for an audit action, falling back to the raw key. */
function actionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action;
}

export function AuditLogPage() {
  const { hasPermission } = useAuth();
  return (
    <AppShell>
      <div className="mx-auto max-w-6xl">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-ink">Audit Log</h1>
          <p className="mt-1 text-sm text-ink-muted">
            An immutable record of every document access and change — the evidence CARF and Joint
            Commission surveyors ask for.
          </p>
        </div>
        {/* UI gate is convenience only — the API enforces audit.read server-side. */}
        {hasPermission(PERMISSIONS.AUDIT_READ) ? <AuditTrail /> : <ForbiddenState />}
      </div>
    </AppShell>
  );
}

function AuditTrail() {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);

  const debouncedDocId = useDebouncedValue(filters.documentId, 300);
  const debouncedActor = useDebouncedValue(filters.actorUserId, 300);

  const params: AuditQueryParams = useMemo(
    () => ({
      action: filters.action || undefined,
      source: (filters.source as AuditSource) || undefined,
      documentId: debouncedDocId || undefined,
      actorUserId: debouncedActor || undefined,
      // Dates are inclusive; extend `to` to end-of-day so the day itself is covered.
      from: filters.from ? new Date(`${filters.from}T00:00:00`).toISOString() : undefined,
      to: filters.to ? new Date(`${filters.to}T23:59:59.999`).toISOString() : undefined,
      page,
      pageSize: PAGE_SIZE,
    }),
    [filters.action, filters.source, debouncedDocId, debouncedActor, filters.from, filters.to, page],
  );

  const query = useQuery({
    queryKey: ['audit', params],
    queryFn: () => listAudit(params),
    placeholderData: keepPreviousData,
  });

  const patch = (part: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...part }));
    setPage(1);
  };

  const forbidden = (query.error as AxiosError | null)?.response?.status === 403;
  const total = query.data?.total ?? 0;
  const totalPages = Math.max(Math.ceil(total / PAGE_SIZE), 1);
  const items = query.data?.items ?? [];
  const hasFilters = Object.values(filters).some((v) => v !== '');

  return (
    <div className="space-y-5">
      <FiltersBar
        filters={filters}
        onChange={patch}
        onClear={() => {
          setFilters(EMPTY_FILTERS);
          setPage(1);
        }}
        onExport={items.length > 0 ? () => exportCsv(items) : undefined}
      />

      {query.isLoading ? (
        <LoadingState label="Loading audit events…" />
      ) : forbidden ? (
        <ForbiddenState />
      ) : query.isError ? (
        <ErrorState
          description="We couldn't load the audit trail."
          onRetry={() => void query.refetch()}
        />
      ) : items.length === 0 ? (
        <EmptyState
          title="No audit events"
          description={
            hasFilters
              ? 'No events match these filters. Try widening the date range or clearing filters.'
              : 'Audit events will appear here as users view, download, and change documents.'
          }
        />
      ) : (
        <AuditTable items={items} isFetching={query.isFetching} />
      )}

      {items.length > 0 && (
        <div className="flex items-center justify-between text-sm text-ink-muted">
          <span>
            Page {page} of {totalPages} · {total} event{total === 1 ? '' : 's'}
          </span>
          <div className="flex gap-2">
            <button
              className="btn-secondary"
              onClick={() => setPage((p) => Math.max(p - 1, 1))}
              disabled={page <= 1}
            >
              Previous
            </button>
            <button
              className="btn-secondary"
              onClick={() => setPage((p) => Math.min(p + 1, totalPages))}
              disabled={page >= totalPages}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function FiltersBar({
  filters,
  onChange,
  onClear,
  onExport,
}: {
  filters: Filters;
  onChange: (part: Partial<Filters>) => void;
  onClear: () => void;
  onExport?: () => void;
}) {
  const hasFilters = Object.values(filters).some((v) => v !== '');
  return (
    <div className="card space-y-4 p-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <label htmlFor="au-action" className="label">
            Action
          </label>
          <select
            id="au-action"
            className="input"
            value={filters.action}
            onChange={(e) => onChange({ action: e.target.value })}
          >
            <option value="">Any action</option>
            {AUDIT_ACTION_VALUES.map((a) => (
              <option key={a} value={a}>
                {actionLabel(a)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="au-source" className="label">
            Source
          </label>
          <select
            id="au-source"
            className="input"
            value={filters.source}
            onChange={(e) => onChange({ source: e.target.value })}
          >
            <option value="">Any source</option>
            {AUDIT_SOURCES.map((s) => (
              <option key={s} value={s}>
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="au-doc" className="label">
            Document ID
          </label>
          <input
            id="au-doc"
            className="input"
            placeholder="Filter by document id"
            value={filters.documentId}
            onChange={(e) => onChange({ documentId: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor="au-actor" className="label">
            User ID
          </label>
          <input
            id="au-actor"
            className="input"
            placeholder="Filter by actor user id"
            value={filters.actorUserId}
            onChange={(e) => onChange({ actorUserId: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor="au-from" className="label">
            From
          </label>
          <input
            id="au-from"
            type="date"
            className="input"
            value={filters.from}
            onChange={(e) => onChange({ from: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor="au-to" className="label">
            To
          </label>
          <input
            id="au-to"
            type="date"
            className="input"
            value={filters.to}
            onChange={(e) => onChange({ to: e.target.value })}
          />
        </div>
      </div>
      <div className="flex items-center justify-between">
        {hasFilters ? (
          <button className="text-xs font-medium text-brand-600 hover:underline" onClick={onClear}>
            Clear filters
          </button>
        ) : (
          <span />
        )}
        <button className="btn-secondary !py-1.5 text-sm" onClick={onExport} disabled={!onExport}>
          Export CSV
        </button>
      </div>
    </div>
  );
}

function AuditTable({ items, isFetching }: { items: AuditEventItem[]; isFetching: boolean }) {
  return (
    <div className={`card overflow-x-auto ${isFetching ? 'opacity-70' : ''}`} aria-busy={isFetching}>
      <table className="w-full min-w-[820px] text-left text-sm">
        <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-ink-muted">
          <tr>
            <th scope="col" className="px-4 py-3 font-medium">
              Time
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              Actor
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              Action
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              Target
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              Source
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              IP
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {items.map((ev) => (
            <tr key={ev.id}>
              <td className="whitespace-nowrap px-4 py-2.5 align-top text-ink-soft">
                {formatDateTime(ev.createdAt)}
              </td>
              <td className="px-4 py-2.5 align-top">
                {ev.actorName ? (
                  <>
                    <div className="font-medium text-ink">{ev.actorName}</div>
                    {ev.actorEmail && <div className="text-xs text-ink-muted">{ev.actorEmail}</div>}
                  </>
                ) : (
                  <span className="text-ink-muted">System</span>
                )}
              </td>
              <td className="px-4 py-2.5 align-top">
                <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${actionBadge(ev.action)}`}>
                  {actionLabel(ev.action)}
                </span>
              </td>
              <td className="px-4 py-2.5 align-top text-ink-soft">
                {ev.documentId ? (
                  <Link
                    to={`/library/${ev.documentId}`}
                    className="font-medium text-brand-700 hover:underline"
                  >
                    {ev.documentTitle ?? ev.documentNumber ?? 'Document'}
                  </Link>
                ) : (
                  <span className="text-ink-muted">{ev.targetType ?? '—'}</span>
                )}
              </td>
              <td className="px-4 py-2.5 align-top text-ink-soft">{ev.source}</td>
              <td className="whitespace-nowrap px-4 py-2.5 align-top text-ink-muted">
                {ev.ipAddress ?? '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Colour cue: denials/failures amber-red, everything else neutral. */
function actionBadge(action: string): string {
  if (action === 'access.denied' || action === 'user.login_failed') {
    return 'bg-red-100 text-red-700';
  }
  if (action === 'acl.changed' || action === 'document.deleted') {
    return 'bg-amber-100 text-amber-800';
  }
  return 'bg-slate-100 text-ink-soft';
}

/** Downloads the current page of events as a CSV file (client-side). */
function exportCsv(items: AuditEventItem[]): void {
  const header = ['Time', 'Actor', 'Email', 'Action', 'Document', 'DocumentId', 'Source', 'IP'];
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const rows = items.map((ev) =>
    [
      ev.createdAt,
      ev.actorName ?? 'System',
      ev.actorEmail ?? '',
      ev.action,
      ev.documentTitle ?? ev.documentNumber ?? '',
      ev.documentId ?? '',
      ev.source,
      ev.ipAddress ?? '',
    ]
      .map((v) => escape(String(v)))
      .join(','),
  );
  const csv = [header.map(escape).join(','), ...rows].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
