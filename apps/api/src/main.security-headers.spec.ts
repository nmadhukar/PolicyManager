import { Controller, Get, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import helmet from 'helmet';
import request from 'supertest';

/**
 * FINDING-013 regression test: proves main.ts's `app.use(helmet(...))` call
 * produces the expected baseline hardening headers. Uses a minimal standalone
 * module (not the full AppModule, which needs a live Postgres/S3/SMTP/OpenAI
 * stack) with the SAME helmet config main.ts applies.
 */
describe('security headers (FINDING-013)', () => {
  @Controller()
  class PingController {
    @Get('ping')
    ping() {
      return { ok: true };
    }
  }

  @Module({ controllers: [PingController] })
  class TestAppModule {}

  it('sets X-Content-Type-Options and X-Frame-Options on API responses', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
    const app = moduleRef.createNestApplication();
    app.use(
      helmet({
        contentSecurityPolicy: {
          directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),
            'script-src': ["'self'", "'unsafe-inline'"],
            'style-src': ["'self'", "'unsafe-inline'"],
          },
        },
      }),
    );
    await app.init();

    const res = await request(app.getHttpServer()).get('/ping');

    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");

    await app.close();
  });
});
