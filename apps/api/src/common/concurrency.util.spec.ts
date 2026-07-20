import { mapWithConcurrency } from './concurrency.util';

describe('concurrency.util', () => {
  describe('mapWithConcurrency', () => {
    it('preserves input order in the result regardless of completion order', async () => {
      const items = [30, 10, 20, 5, 25];
      const result = await mapWithConcurrency(items, 3, async (ms) => {
        await new Promise((r) => setTimeout(r, ms));
        return ms;
      });
      expect(result).toEqual(items);
    });

    it('never runs more than `limit` workers concurrently', async () => {
      let active = 0;
      let maxActive = 0;
      const items = Array.from({ length: 10 }, (_, i) => i);

      await mapWithConcurrency(items, 3, async (i) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 1));
        active--;
        return i;
      });

      expect(maxActive).toBeLessThanOrEqual(3);
    });

    it('passes both item and index to the worker', async () => {
      const seen: Array<[string, number]> = [];
      await mapWithConcurrency(['a', 'b', 'c'], 2, async (item, index) => {
        seen.push([item, index]);
        return null;
      });
      expect(seen.sort((a, b) => a[1] - b[1])).toEqual([
        ['a', 0],
        ['b', 1],
        ['c', 2],
      ]);
    });

    it('returns an empty array for empty input without invoking the worker', async () => {
      const worker = jest.fn();
      const result = await mapWithConcurrency([], 5, worker);
      expect(result).toEqual([]);
      expect(worker).not.toHaveBeenCalled();
    });

    it('handles a limit larger than the item count', async () => {
      const result = await mapWithConcurrency([1, 2], 10, async (n) => n * 2);
      expect(result).toEqual([2, 4]);
    });
  });
});
