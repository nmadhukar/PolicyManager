import { EmbeddingCache } from './embedding-cache.service';
import type { RagConfigService } from './rag-config.service';

describe('EmbeddingCache', () => {
  const vec = (n = 0.1) => new Array(4).fill(n);

  const makeConfig = (ttlMs = 300_000, max = 500): RagConfigService =>
    ({ embeddingCacheTtlMs: ttlMs, embeddingCacheMaxEntries: max }) as unknown as RagConfigService;

  it('caches and returns a vector by (query, model) — a hit (AC2)', () => {
    const cache = new EmbeddingCache(makeConfig());
    cache.set('seclusion', 'model-a', vec(0.2));
    expect(cache.get('seclusion', 'model-a')).toEqual(vec(0.2));
  });

  it('misses on a different query or model (AC2)', () => {
    const cache = new EmbeddingCache(makeConfig());
    cache.set('seclusion', 'model-a', vec());
    expect(cache.get('restraint', 'model-a')).toBeUndefined();
    expect(cache.get('seclusion', 'model-b')).toBeUndefined();
  });

  it('is disabled when TTL <= 0 (get/set are no-ops)', () => {
    const cache = new EmbeddingCache(makeConfig(0));
    cache.set('q', 'm', vec());
    expect(cache.get('q', 'm')).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it('expires entries after the TTL (AC2)', () => {
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000);
    const cache = new EmbeddingCache(makeConfig(100));
    cache.set('q', 'm', vec());
    nowSpy.mockReturnValue(1_050); // within TTL
    expect(cache.get('q', 'm')).toBeDefined();
    nowSpy.mockReturnValue(1_200); // past TTL
    expect(cache.get('q', 'm')).toBeUndefined();
    nowSpy.mockRestore();
  });

  it('evicts the oldest entry past max size (LRU) (AC2)', () => {
    const cache = new EmbeddingCache(makeConfig(300_000, 2));
    cache.set('a', 'm', vec(0.1));
    cache.set('b', 'm', vec(0.2));
    cache.set('c', 'm', vec(0.3)); // 'a' should be evicted
    expect(cache.size()).toBe(2);
    expect(cache.get('a', 'm')).toBeUndefined();
    expect(cache.get('b', 'm')).toBeDefined();
    expect(cache.get('c', 'm')).toBeDefined();
  });

  it('LRU touch on get keeps a recently-read entry alive', () => {
    const cache = new EmbeddingCache(makeConfig(300_000, 2));
    cache.set('a', 'm', vec(0.1));
    cache.set('b', 'm', vec(0.2));
    cache.get('a', 'm'); // touch 'a' → 'b' is now oldest
    cache.set('c', 'm', vec(0.3)); // evicts 'b', keeps 'a'
    expect(cache.get('a', 'm')).toBeDefined();
    expect(cache.get('b', 'm')).toBeUndefined();
  });

  it('clear() empties the cache', () => {
    const cache = new EmbeddingCache(makeConfig());
    cache.set('a', 'm', vec());
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});
