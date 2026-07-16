import { RagMetricsService } from './rag-metrics.service';
import type { RagConfigService } from '../rag-config.service';

/**
 * Unit tests for the RAG status/metrics service. RagConfigService and Prisma are
 * hand-rolled mocks (repo convention — see embedding.service.spec.ts). The suite
 * asserts (1) the config values are surfaced verbatim, (2) the embedding backlog
 * maps the grouped counts onto the five fixed keys (missing → 0), and (3) — the
 * critical security invariant — NO secret / API key ever appears in the output.
 */
describe('RagMetricsService', () => {
  const makeConfig = (over: Partial<Record<string, unknown>> = {}): RagConfigService =>
    ({
      enabled: true,
      isConfigured: () => true,
      embeddingModel: 'text-embedding-3-small',
      embeddingDimensions: 1536,
      chatModel: 'gpt-4o-mini',
      // A realistic secret; every test asserts this NEVER reaches the output.
      openaiApiKey: 'sk-secret',
      ...over,
    }) as unknown as RagConfigService;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const makePrisma = (groupByRows: Array<Record<string, unknown>>): any => ({
    documentVersion: {
      groupBy: jest.fn().mockResolvedValue(groupByRows),
    },
  });

  const build = (config: RagConfigService, prisma: unknown) =>
    new RagMetricsService(config, prisma as never);

  it('returns config values verbatim from RagConfigService', async () => {
    const config = makeConfig({
      enabled: true,
      isConfigured: () => true,
      embeddingModel: 'text-embedding-3-large',
      embeddingDimensions: 3072,
      chatModel: 'gpt-4o',
    });
    const svc = build(config, makePrisma([]));

    const status = await svc.getStatus();

    expect(status.enabled).toBe(true);
    expect(status.configured).toBe(true);
    expect(status.embeddingModel).toBe('text-embedding-3-large');
    expect(status.embeddingDimensions).toBe(3072);
    expect(status.chatModel).toBe('gpt-4o');
  });

  it('reflects disabled / not-configured flags', async () => {
    const config = makeConfig({ enabled: false, isConfigured: () => false });
    const svc = build(config, makePrisma([]));

    const status = await svc.getStatus();

    expect(status.enabled).toBe(false);
    expect(status.configured).toBe(false);
  });

  it('maps the grouped backlog counts onto all five keys', async () => {
    const prisma = makePrisma([
      { embeddingStatus: 'pending', _count: 3 },
      { embeddingStatus: 'processing', _count: 1 },
      { embeddingStatus: 'done', _count: 42 },
      { embeddingStatus: 'failed', _count: 2 },
      { embeddingStatus: 'skipped', _count: 5 },
    ]);
    const svc = build(makeConfig(), prisma);

    const status = await svc.getStatus();

    expect(status.embeddingBacklog).toEqual({
      pending: 3,
      processing: 1,
      done: 42,
      failed: 2,
      skipped: 5,
    });
    expect(prisma.documentVersion.groupBy).toHaveBeenCalledWith({
      by: ['embeddingStatus'],
      _count: true,
    });
  });

  it('defaults missing statuses to 0', async () => {
    // Only two statuses present in the grouped result; the other three → 0.
    const prisma = makePrisma([
      { embeddingStatus: 'done', _count: 10 },
      { embeddingStatus: 'pending', _count: 4 },
    ]);
    const svc = build(makeConfig(), prisma);

    const status = await svc.getStatus();

    expect(status.embeddingBacklog).toEqual({
      pending: 4,
      processing: 0,
      done: 10,
      failed: 0,
      skipped: 0,
    });
  });

  it('yields an all-zero backlog when there are no versions', async () => {
    const svc = build(makeConfig(), makePrisma([]));

    const status = await svc.getStatus();

    expect(status.embeddingBacklog).toEqual({
      pending: 0,
      processing: 0,
      done: 0,
      failed: 0,
      skipped: 0,
    });
  });

  // --- CRITICAL security invariant ---
  it('NEVER leaks the API key or any secret in the status output', async () => {
    // The mock config carries openaiApiKey='sk-secret'; it must not surface.
    const config = makeConfig({ openaiApiKey: 'sk-secret' });
    const svc = build(config, makePrisma([{ embeddingStatus: 'done', _count: 1 }]));

    const status = await svc.getStatus();

    // No secret key names on the returned object.
    const keys = Object.keys(status);
    expect(keys).not.toContain('apiKey');
    expect(keys).not.toContain('openaiApiKey');
    expect(keys).not.toContain('secret');

    // And the actual secret string appears nowhere in the serialized output.
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain('sk-secret');
    expect(serialized.toLowerCase()).not.toContain('apikey');
  });
});
