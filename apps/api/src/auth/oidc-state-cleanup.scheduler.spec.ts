import { OidcStateCleanupScheduler } from './oidc-state-cleanup.scheduler';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * FINDING-019: cleanupExpiredState must not re-enter deleteMany() while a
 * prior invocation is still in flight — mirrors NotificationsScheduler /
 * EmbeddingScheduler's `running` guard.
 */
describe('OidcStateCleanupScheduler', () => {
  function build(deleteMany: jest.Mock) {
    const prisma = { oidcState: { deleteMany } } as unknown as PrismaService;
    return new OidcStateCleanupScheduler(prisma);
  }

  it('deletes rows past expiresAt', async () => {
    const deleteMany = jest.fn().mockResolvedValue({ count: 3 });
    const scheduler = build(deleteMany);

    await scheduler.cleanupExpiredState();

    expect(deleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lt: expect.any(Date) } },
    });
  });

  it('is a no-op when a prior call is still in flight', async () => {
    let resolveFirst!: (v: { count: number }) => void;
    const first = new Promise<{ count: number }>((resolve) => {
      resolveFirst = resolve;
    });
    const deleteMany = jest.fn().mockReturnValueOnce(first);
    const scheduler = build(deleteMany);

    const firstCall = scheduler.cleanupExpiredState();
    const secondCall = scheduler.cleanupExpiredState();

    expect(deleteMany).toHaveBeenCalledTimes(1);

    resolveFirst({ count: 0 });
    await Promise.all([firstCall, secondCall]);

    expect(deleteMany).toHaveBeenCalledTimes(1);
  });

  it('runs again on the next tick once the prior call has completed', async () => {
    const deleteMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const scheduler = build(deleteMany);

    await scheduler.cleanupExpiredState();
    await scheduler.cleanupExpiredState();

    expect(deleteMany).toHaveBeenCalledTimes(2);
  });

  it('clears the running flag even when deleteMany rejects, so the next tick is not permanently blocked', async () => {
    const deleteMany = jest
      .fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({ count: 0 });
    const scheduler = build(deleteMany);

    await scheduler.cleanupExpiredState(); // swallows the error, logs it
    await scheduler.cleanupExpiredState(); // must be allowed to run

    expect(deleteMany).toHaveBeenCalledTimes(2);
  });
});
