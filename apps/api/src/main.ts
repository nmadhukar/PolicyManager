import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api', { exclude: ['health'] });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  app.enableCors({ origin: true, credentials: true });

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

  const port = process.env.API_PORT ?? 3000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`PolicyManager API listening on :${port}`);
}

bootstrap();
