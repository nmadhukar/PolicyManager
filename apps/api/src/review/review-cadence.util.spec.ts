import { addDays, addMonths, advanceReviewDate } from './review-cadence.util';

/**
 * Pure date math for the QC review cadence. The review-completion flow uses
 * {@link advanceReviewDate} to roll a document's nextReviewDate forward; the sweep
 * uses {@link addDays} for the lead-time window. All are clock-injected (no `new
 * Date()` inside) so they are deterministic and testable.
 */
describe('review-cadence.util', () => {
  describe('addDays', () => {
    it('adds whole days without mutating the input', () => {
      const base = new Date('2026-01-01T00:00:00.000Z');
      expect(addDays(base, 14).toISOString()).toBe('2026-01-15T00:00:00.000Z');
      // input untouched
      expect(base.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    });

    it('supports negative offsets', () => {
      expect(addDays(new Date('2026-01-15T00:00:00.000Z'), -14).toISOString()).toBe(
        '2026-01-01T00:00:00.000Z',
      );
    });
  });

  describe('addMonths', () => {
    it('adds months keeping the day of month', () => {
      expect(addMonths(new Date('2026-01-15T00:00:00.000Z'), 3).toISOString()).toBe(
        '2026-04-15T00:00:00.000Z',
      );
    });

    it('rolls over the year boundary', () => {
      expect(addMonths(new Date('2026-11-10T00:00:00.000Z'), 3).toISOString()).toBe(
        '2027-02-10T00:00:00.000Z',
      );
    });

    it('clamps to the last day when the target month is shorter', () => {
      // Jan 31 + 1 month => Feb 28 (2026 is not a leap year), never a March overflow.
      expect(addMonths(new Date('2026-01-31T00:00:00.000Z'), 1).toISOString()).toBe(
        '2026-02-28T00:00:00.000Z',
      );
    });
  });

  describe('advanceReviewDate', () => {
    const now = new Date('2026-07-13T00:00:00.000Z');

    it('quarterly advances 3 months from now', () => {
      expect(advanceReviewDate({ cadence: 'quarterly', now }).toISOString()).toBe(
        '2026-10-13T00:00:00.000Z',
      );
    });

    it('annual advances 12 months from now', () => {
      expect(advanceReviewDate({ cadence: 'annual', now }).toISOString()).toBe(
        '2027-07-13T00:00:00.000Z',
      );
    });

    it('custom requires an explicit override and uses it verbatim', () => {
      expect(
        advanceReviewDate({ cadence: 'custom', now, override: '2026-12-01' }).toISOString(),
      ).toBe('2026-12-01T00:00:00.000Z');
    });

    it('none requires an explicit override and uses it verbatim', () => {
      expect(
        advanceReviewDate({ cadence: 'none', now, override: '2027-01-01' }).toISOString(),
      ).toBe('2027-01-01T00:00:00.000Z');
    });

    it('an override wins even for quarterly/annual cadences', () => {
      expect(
        advanceReviewDate({ cadence: 'quarterly', now, override: '2026-09-09' }).toISOString(),
      ).toBe('2026-09-09T00:00:00.000Z');
    });

    it('throws when custom/none is given no override', () => {
      expect(() => advanceReviewDate({ cadence: 'custom', now })).toThrow(/next review date/i);
      expect(() => advanceReviewDate({ cadence: 'none', now })).toThrow(/next review date/i);
    });

    it('throws when the override is not a valid date', () => {
      expect(() =>
        advanceReviewDate({ cadence: 'custom', now, override: 'not-a-date' }),
      ).toThrow(/valid/i);
    });
  });
});
