import { EmbeddingScheduler } from './embedding.scheduler';
import type { EmbeddingService } from './embedding.service';

/**
 * FINDING-015: embeddingBacklogSweep must not re-enter processPending() while a
 * prior invocation is still in flight — mirrors NotificationsScheduler's
 * `running` guard, which itself mirrors DocumentExtractionService.pollPending.
 */
describe('EmbeddingScheduler', () => {
  function build(processPending: jest.Mock) {
    const embedding = { processPending } as unknown as EmbeddingService;
    return new EmbeddingScheduler(embedding);
  }

  it('is a no-op when a prior call is still in flight', async () => {
    let resolveFirst!: (v: { processed: number; done: number; skipped: number; failed: number }) => void;
    const first = new Promise<{ processed: number; done: number; skipped: number; failed: number }>(
      (resolve) => {
        resolveFirst = resolve;
      },
    );
    const processPending = jest.fn().mockReturnValueOnce(first);
    const scheduler = build(processPending);

    const firstCall = scheduler.embeddingBacklogSweep();
    const secondCall = scheduler.embeddingBacklogSweep();

    expect(processPending).toHaveBeenCalledTimes(1);

    resolveFirst({ processed: 1, done: 1, skipped: 0, failed: 0 });
    await Promise.all([firstCall, secondCall]);

    expect(processPending).toHaveBeenCalledTimes(1);
  });

  it('runs again on the next tick once the prior call has completed', async () => {
    const processPending = jest
      .fn()
      .mockResolvedValueOnce({ processed: 1, done: 1, skipped: 0, failed: 0 })
      .mockResolvedValueOnce({ processed: 0, done: 0, skipped: 0, failed: 0 });
    const scheduler = build(processPending);

    await scheduler.embeddingBacklogSweep();
    await scheduler.embeddingBacklogSweep();

    expect(processPending).toHaveBeenCalledTimes(2);
  });

  it('clears the running flag even when processPending rejects, so the next tick is not permanently blocked', async () => {
    const processPending = jest
      .fn()
      .mockRejectedValueOnce(new Error('embedding provider down'))
      .mockResolvedValueOnce({ processed: 1, done: 1, skipped: 0, failed: 0 });
    const scheduler = build(processPending);

    await scheduler.embeddingBacklogSweep(); // swallows the error, logs it
    await scheduler.embeddingBacklogSweep(); // must be allowed to run

    expect(processPending).toHaveBeenCalledTimes(2);
  });
});
