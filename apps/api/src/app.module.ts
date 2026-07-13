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
import { SmtpModule } from './smtp/smtp.module';

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
    ReviewModule,
    SmtpModule,
  ],
})
export class AppModule {}
