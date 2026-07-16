import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from './prisma/prisma.module';
import { HealthModule } from './health/health.module';
import { MailModule } from './mail/mail.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { StorageModule } from './storage/storage.module';
import { StorageAdminModule } from './storage-admin/storage-admin.module';
import { DocumentsModule } from './documents/documents.module';
import { AuditModule } from './audit/audit.module';
import { ReviewModule } from './review/review.module';
import { AttestationModule } from './attestation/attestation.module';
import { SmtpModule } from './smtp/smtp.module';
import { ApiClientsModule } from './api-clients/api-clients.module';
import { PublicApiModule } from './public-api/public-api.module';
import { ImportsModule } from './imports/imports.module';
import { SearchModule } from './search/search.module';
import { NotificationsModule } from './notifications/notifications.module';
import { EvidenceModule } from './evidence/evidence.module';
import { RagModule } from './rag/rag.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env', '.env'] }),
    // SM3: global request throttling (per-IP). The default limit is generous so
    // normal traffic is unaffected; the sensitive auth routes tighten it with
    // @Throttle. `THROTTLE_DISABLED=true` skips it entirely (used by the test env so
    // suites making many rapid requests are not rate-limited).
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            name: 'default',
            ttl: Number(config.get('THROTTLE_TTL', 60_000)),
            limit: Number(config.get('THROTTLE_LIMIT', 300)),
          },
        ],
        skipIf: () =>
          String(config.get('THROTTLE_DISABLED', 'false')) === 'true' ||
          String(config.get('NODE_ENV')) === 'test',
      }),
    }),
    // Drives the daily QC review sweep (ReviewScheduler).
    ScheduleModule.forRoot(),
    PrismaModule,
    HealthModule,
    MailModule,
    AuthModule,
    AuditModule,
    UsersModule,
    StorageModule,
    StorageAdminModule,
    DocumentsModule,
    AttestationModule,
    ReviewModule,
    SmtpModule,
    // Phase 7 — public read-only API + its (JWT-guarded) client management.
    ApiClientsModule,
    PublicApiModule,
    // Phase 8 — bulk import & consolidation (CSV manifest + bulk upload).
    ImportsModule,
    SearchModule,
    NotificationsModule,
    EvidenceModule,
    // RAG chatbot (ADR-0002): embedding, hybrid retrieval, agent layer, and the
    // grounded chat endpoint + metrics.
    RagModule,
  ],
  // SM3: enforce the throttler globally (auth routes add tighter @Throttle limits).
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
