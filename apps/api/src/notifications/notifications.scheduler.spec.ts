import { NotificationsScheduler } from './notifications.scheduler';
import type { NotificationsService } from './notifications.service';

/**
 * FINDING-005: hourlyDigestSweep must not re-enter runDigest() while a prior
 * invocation is still in flight — mirrors DocumentExtractionService.pollPending's
 * polling-flag guard.
 */
describe('NotificationsScheduler', () => {
  function build(runDigest: jest.Mock) {
    const notifications = { runDigest } as unknown as NotificationsService;
    return new NotificationsScheduler(notifications);
  }

  it('is a no-op when a prior call is still in flight', async () => {
    let resolveFirst!: (v: { usersConsidered: number; digestsSent: number; failed: number }) => void;
    const first = new Promise<{ usersConsidered: number; digestsSent: number; failed: number }>((resolve) => {
      resolveFirst = resolve;
    });
    const runDigest = jest.fn().mockReturnValueOnce(first);
    const scheduler = build(runDigest);

    const firstCall = scheduler.hourlyDigestSweep();
    // A second tick fires while the first is still pending.
    const secondCall = scheduler.hourlyDigestSweep();

    expect(runDigest).toHaveBeenCalledTimes(1);

    resolveFirst({ usersConsidered: 1, digestsSent: 1, failed: 0 });
    await Promise.all([firstCall, secondCall]);

    // Still exactly one underlying runDigest call — the overlapping tick was skipped.
    expect(runDigest).toHaveBeenCalledTimes(1);
  });

  it('runs again on the next tick once the prior call has completed', async () => {
    const runDigest = jest
      .fn()
      .mockResolvedValueOnce({ usersConsidered: 1, digestsSent: 1, failed: 0 })
      .mockResolvedValueOnce({ usersConsidered: 1, digestsSent: 0, failed: 0 });
    const scheduler = build(runDigest);

    await scheduler.hourlyDigestSweep();
    await scheduler.hourlyDigestSweep();

    expect(runDigest).toHaveBeenCalledTimes(2);
  });

  it('clears the running flag even when runDigest rejects, so the next tick is not permanently blocked', async () => {
    const runDigest = jest
      .fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({ usersConsidered: 1, digestsSent: 1, failed: 0 });
    const scheduler = build(runDigest);

    await scheduler.hourlyDigestSweep(); // swallows the error, logs it
    await scheduler.hourlyDigestSweep(); // must be allowed to run

    expect(runDigest).toHaveBeenCalledTimes(2);
  });
});
