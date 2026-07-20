/**
 * Bounded-concurrency mapper shared by services that fan out per-item async
 * work (DB writes, notification sends) without wanting either fully
 * sequential (slow) or fully parallel (unbounded connection/API pressure)
 * execution. Preserves input order in the result array regardless of which
 * worker finishes first.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}
