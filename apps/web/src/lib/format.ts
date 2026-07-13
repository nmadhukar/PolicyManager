import type { DocumentStatus } from '@policymanager/shared';

/** Formats an ISO date as a short, locale-aware date; em dash when absent. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Formats an ISO timestamp as a short date + time; em dash when absent. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Human-readable byte size (e.g. "12.3 KB"). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exp;
  return `${value.toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`;
}

/** Title-case, human label for a document status enum. */
export function statusLabel(status: DocumentStatus): string {
  return status
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Tailwind classes for a status badge, by lifecycle stage. */
export function statusBadgeClasses(status: DocumentStatus): string {
  switch (status) {
    case 'published':
    case 'approved':
      return 'bg-green-100 text-green-700';
    case 'in_review':
      return 'bg-amber-100 text-amber-700';
    case 'archived':
    case 'retired':
      return 'bg-slate-200 text-ink-soft';
    default:
      return 'bg-slate-100 text-ink-soft';
  }
}
