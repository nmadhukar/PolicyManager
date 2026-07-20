import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';

/**
 * SM4: CORS origin from an explicit allow-list (`WEB_APP_URL` / `FRONTEND_URL` /
 * `CORS_ALLOWED_ORIGINS`, comma-split). When nothing is configured, reflect the
 * request origin ONLY in non-production (dev convenience); production denies
 * cross-origin. Credentials are OFF — auth is a bearer token, not a cookie, so
 * `credentials: true` (which is incompatible with a reflected origin anyway) is
 * never needed.
 */
function corsOrigin(): boolean | string[] {
  const origins = [
    process.env.WEB_APP_URL,
    process.env.FRONTEND_URL,
    process.env.CORS_ALLOWED_ORIGINS,
  ]
    .filter((v): v is string => !!v)
    .flatMap((v) => v.split(','))
    .map((s) => s.trim())
    .filter(Boolean);
  if (origins.length > 0) return Array.from(new Set(origins));
  const isProd = (process.env.NODE_ENV ?? 'development') === 'production';
  return !isProd; // dev: reflect; prod: deny cross-origin when unconfigured
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // FINDING-013: baseline hardening headers (X-Content-Type-Options,
  // X-Frame-Options, etc.) on every response. helmet's default CSP would
  // block Swagger UI's inline script/style (served from this same app at
  // /api/docs), so the script/style directives are relaxed to allow inline —
  // everything else keeps helmet's strict defaults.
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

  app.setGlobalPrefix('api', { exclude: ['health'] });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );

  // SL1: trust exactly N proxy hops so `req.ip` is the real client (used for the
  // audit + attestation trail), not a spoofable X-Forwarded-For. Default 0 = trust
  // none (use the socket peer). Behind one LB/reverse proxy, set TRUST_PROXY_HOPS=1.
  const hops = Number(process.env.TRUST_PROXY_HOPS ?? 0);
  app.getHttpAdapter().getInstance().set('trust proxy', Number.isFinite(hops) ? hops : 0);

  app.enableCors({ origin: corsOrigin(), credentials: false });

  const swaggerConfig = new DocumentBuilder()
    .setTitle('PolicyManager API')
    .setDescription('Document management for behavioral health compliance')
    .setVersion('1.0')
    // Internal (web) API: JWT bearer. Public API v1: a separate API-key scheme so
    // the two auth models never collide in the docs (Phase 7).
    .addBearerAuth()
    .addApiKey(
      { type: 'apiKey', name: 'X-Api-Key', in: 'header', description: 'Public API v1 key: `clientId.secret` (also accepted as `Authorization: Bearer`).' },
      'api-key',
    )
    .addTag('public-api-v1', 'Read-only public API for EMR/AI integration (API-key auth).')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  // FINDING-015: without this, NestJS lifecycle hooks (e.g.
  // PrismaService.onModuleDestroy's $disconnect()) never run on SIGTERM/SIGINT,
  // so container rolling restarts kill the process without draining the DB pool.
  app.enableShutdownHooks();

  const port = process.env.API_PORT ?? 3000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`PolicyManager API listening on :${port}`);
}

bootstrap();
