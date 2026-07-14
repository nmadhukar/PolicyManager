import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AzureOidcService } from './azure-oidc.service';
import { PermissionsGuard } from './guards/permissions.guard';
import { JwtStrategy } from './strategies/jwt.strategy';

/**
 * Auth & RBAC. Secrets/TTLs are read per-operation from ConfigService, so
 * JwtModule is registered without a global secret.
 */
@Module({
  imports: [PassportModule, JwtModule.register({})],
  controllers: [AuthController],
  providers: [AuthService, AzureOidcService, JwtStrategy, PermissionsGuard],
  exports: [AuthService, PermissionsGuard],
})
export class AuthModule {}
