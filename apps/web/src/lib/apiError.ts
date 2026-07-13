import { AxiosError } from 'axios';

/**
 * Maps an unknown thrown value (usually an AxiosError) to a human-readable,
 * non-technical message — the same status-first pattern the forms already use
 * inline, extracted so mutation `onError` handlers stay consistent.
 *
 * Resolution order: an explicit per-status override → a network-error hint →
 * the caller's fallback. Raw server messages are intentionally NOT surfaced to
 * avoid leaking internals into user-facing copy.
 */
export function apiErrorMessage(
  err: unknown,
  fallback = 'Something went wrong. Please try again.',
  byStatus?: Record<number, string>,
): string {
  const ax = err as AxiosError | undefined;
  const status = ax?.response?.status;

  if (status && byStatus && byStatus[status]) return byStatus[status];

  // No response at all → the request never reached the server.
  if (ax && ax.isAxiosError && !ax.response) {
    return 'Network error — check your connection and try again.';
  }

  if (status === 403) return 'You do not have permission to do that.';

  return fallback;
}

/** Convenience accessor for the HTTP status of a thrown Axios error, if any. */
export function apiErrorStatus(err: unknown): number | undefined {
  return (err as AxiosError | undefined)?.response?.status;
}
