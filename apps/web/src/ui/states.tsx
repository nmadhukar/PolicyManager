import { ReactNode } from 'react';

/** Consistent loading / empty / error / forbidden states for every data screen. */

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="card flex items-center gap-3 p-6 text-sm text-ink-muted" role="status" aria-live="polite">
      <span
        aria-hidden
        className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600"
      />
      {label}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="card p-10 text-center">
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {description && <p className="mx-auto mt-1 max-w-md text-sm text-ink-muted">{description}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function ErrorState({
  title = 'Something went wrong',
  description,
  onRetry,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="card border-red-200 p-6" role="alert">
      <h3 className="text-sm font-semibold text-red-700">{title}</h3>
      {description && <p className="mt-1 text-sm text-ink-soft">{description}</p>}
      {onRetry && (
        <button className="btn-secondary mt-4" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function ForbiddenState({
  description = 'You do not have permission to view this page. Contact an administrator if you believe this is a mistake.',
}: {
  description?: string;
}) {
  return (
    <div className="card p-10 text-center" role="alert">
      <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-red-50 text-xl text-red-600">
        ⃠
      </div>
      <h3 className="mt-3 text-base font-semibold text-ink">Access denied</h3>
      <p className="mx-auto mt-1 max-w-md text-sm text-ink-muted">{description}</p>
    </div>
  );
}
