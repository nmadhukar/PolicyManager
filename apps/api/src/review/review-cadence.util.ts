import type { ReviewCadence } from '@policymanager/shared';

/**
 * Pure date helpers for QC review scheduling. Kept free of `new Date()` so the
 * caller injects "now" and results are deterministic/testable (AGENTS.md §6).
 */

/** Returns a NEW Date `days` after `base` (negative allowed); never mutates input. */
export function addDays(base: Date, days: number): Date {
  const d = new Date(base.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/**
 * Returns a NEW Date `months` after `base`, keeping the day-of-month where possible
 * and CLAMPING to the last valid day when the target month is shorter (so Jan 31 +
 * 1mo => Feb 28/29, not a March overflow). Operates in UTC.
 */
export function addMonths(base: Date, months: number): Date {
  const year = base.getUTCFullYear();
  const month = base.getUTCMonth();
  const day = base.getUTCDate();
  const target = new Date(base.getTime());
  target.setUTCFullYear(year, month + months, 1); // move to the 1st of the target month first
  const daysInTargetMonth = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, daysInTargetMonth));
  return target;
}

/** Args for {@link advanceReviewDate}. `now` is injected for determinism. */
export interface AdvanceReviewDateArgs {
  cadence: ReviewCadence;
  now: Date;
  /** ISO date string. Required for `none`/`custom`; overrides for `quarterly`/`annual`. */
  override?: string | null;
}

/**
 * Computes a document's next review date after a review is completed.
 *
 * Rules:
 *  - an explicit `override` always wins (used for `custom`/`none`, allowed for any);
 *  - `quarterly` => now + 3 months; `annual` => now + 12 months (the review resets
 *    the clock from completion day, which is what clinics expect after a sign-off);
 *  - `none`/`custom` with no override is a caller error (throws) — the API surfaces
 *    it as a 400.
 *
 * Throws on an invalid override date so bad input never silently corrupts the schedule.
 */
export function advanceReviewDate({ cadence, now, override }: AdvanceReviewDateArgs): Date {
  if (override != null && override !== '') {
    const d = new Date(override);
    if (Number.isNaN(d.getTime())) {
      throw new Error('newNextReviewDate must be a valid date');
    }
    return d;
  }
  switch (cadence) {
    case 'quarterly':
      return addMonths(now, 3);
    case 'annual':
      return addMonths(now, 12);
    default:
      // none | custom without an override.
      throw new Error('A next review date is required for this cadence');
  }
}
