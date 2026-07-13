import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
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

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env', '.env'] }),
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
  ],
})
export class AppModule {}
