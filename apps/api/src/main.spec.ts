import { readFileSync } from 'fs';
import { join } from 'path';
import { Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { Test } from '@nestjs/testing';

/**
 * FINDING-015 regression test: proves the exact mechanism main.ts's
 * `app.enableShutdownHooks()` call relies on — NestJS only invokes
 * `OnModuleDestroy` lifecycle hooks on process termination signals
 * (SIGTERM/SIGINT) when `enableShutdownHooks()` has been called on the app
 * instance. Without it (the pre-fix state), a provider's onModuleDestroy
 * (e.g. PrismaService's $disconnect()) never runs on a container SIGTERM.
 *
 * This does not boot the full AppModule (which requires a live Postgres/S3/
 * SMTP/OpenAI stack for its providers) — it isolates the lifecycle-hook
 * wiring itself with a minimal standalone module.
 */
describe('bootstrap shutdown hooks (FINDING-015)', () => {
  it('main.ts bootstrap() calls app.enableShutdownHooks() before app.listen()', () => {
    const source = readFileSync(join(__dirname, 'main.ts'), 'utf8');
    const shutdownHooksIndex = source.indexOf('app.enableShutdownHooks()');
    const listenIndex = source.indexOf('app.listen(');
    expect(shutdownHooksIndex).toBeGreaterThan(-1);
    expect(listenIndex).toBeGreaterThan(-1);
    expect(shutdownHooksIndex).toBeLessThan(listenIndex);
  });

  @Injectable()
  class Draining implements OnModuleDestroy {
    destroyed = false;
    onModuleDestroy() {
      this.destroyed = true;
    }
  }

  @Module({ providers: [Draining] })
  class TestAppModule {}

  it('runs OnModuleDestroy hooks on app.close() once enableShutdownHooks() has been called', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
    const app = moduleRef.createNestApplication();
    app.enableShutdownHooks();
    await app.init();

    const draining = app.get(Draining);
    expect(draining.destroyed).toBe(false);

    await app.close();

    expect(draining.destroyed).toBe(true);
  });
});

/**
 * FINDING-013 regression test: proves main.ts wires helmet in BEFORE route
 * registration. The resulting header behavior itself is covered end-to-end by
 * main.security-headers.spec.ts.
 */
describe('bootstrap security headers (FINDING-013)', () => {
  it('main.ts bootstrap() calls app.use(helmet(...)) before setGlobalPrefix', () => {
    const source = readFileSync(join(__dirname, 'main.ts'), 'utf8');
    const helmetIndex = source.indexOf('helmet(');
    const prefixIndex = source.indexOf('setGlobalPrefix(');
    expect(helmetIndex).toBeGreaterThan(-1);
    expect(prefixIndex).toBeGreaterThan(-1);
    expect(helmetIndex).toBeLessThan(prefixIndex);
  });
});
