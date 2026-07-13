import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AUDIT_ACTIONS } from '@policymanager/shared';
import type { AuthUser } from '@policymanager/shared';
import { AuditService } from '../audit/audit.service';
import { ReqContext, type RequestContext } from '../audit/request-context';
import { AuthService } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

/** Neutral message returned by forgot-password regardless of account existence. */
const FORGOT_PASSWORD_MESSAGE =
  'If an account exists for that email, a password reset link has been sent.';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Local email + password login. Returns access + refresh tokens.' })
  async login(@Body() dto: LoginDto, @ReqContext() ctx: RequestContext) {
    try {
      const result = await this.auth.login(dto.email, dto.password);
      // Audit is best-effort and out of the critical path (AGENTS.md §8).
      await this.audit.record({
        action: AUDIT_ACTIONS.USER_LOGIN,
        actorUserId: result.user.id,
        targetType: 'user',
        ...ctx,
      });
      return result;
    } catch (err) {
      // Record the failure WITHOUT confirming the account exists (email in meta).
      await this.audit.record({
        action: AUDIT_ACTIONS.USER_LOGIN_FAILED,
        targetType: 'user',
        ...ctx,
        metadata: { email: dto.email },
      });
      throw err;
    }
  }

  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rotate a refresh token for a new access + refresh pair.' })
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke a refresh token.' })
  async logout(@Body() dto: RefreshDto): Promise<void> {
    await this.auth.logout(dto.refreshToken);
  }

  @Post('forgot-password')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Request a password reset link. Always returns 200 (no account enumeration).',
  })
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.auth.forgotPassword(dto.email);
    return { message: FORGOT_PASSWORD_MESSAGE };
  }

  @Post('reset-password')
  @HttpCode(200)
  @ApiOperation({ summary: 'Complete a password reset using an emailed token.' })
  async resetPassword(@Body() dto: ResetPasswordDto, @ReqContext() ctx: RequestContext) {
    const { userId } = await this.auth.resetPassword(dto.token, dto.newPassword);
    await this.audit.record({
      action: AUDIT_ACTIONS.USER_PASSWORD_RESET,
      actorUserId: userId,
      targetType: 'user',
      ...ctx,
    });
    return { message: 'Your password has been reset. You can now sign in.' };
  }

  @Post('change-password')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Change the authenticated user\'s password (verifies the current one).' })
  changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(user.id, dto.currentPassword, dto.newPassword);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Current authenticated user with resolved roles + permissions.' })
  me(@CurrentUser() user: AuthUser): AuthUser {
    return user;
  }
}
