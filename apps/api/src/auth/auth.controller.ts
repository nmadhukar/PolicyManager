import { Body, Controller, Get, HttpCode, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { AUDIT_ACTIONS } from '@policymanager/shared';
import type { AuthUser } from '@policymanager/shared';
import { AuditService } from '../audit/audit.service';
import { ReqContext, type RequestContext } from '../audit/request-context';
import { AZURE_OIDC_PROVIDER, AzureOidcService } from './azure-oidc.service';
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

/**
 * SM3: tight per-IP limit for credential/token endpoints (10 req / 60s) to blunt
 * brute-force + credential-stuffing. Overrides the generous global default; the
 * whole throttler is skippable via `THROTTLE_DISABLED` (test env).
 */
const AUTH_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly azureOidc: AzureOidcService,
    private readonly config: ConfigService,
  ) {}

  @Post('login')
  @HttpCode(200)
  @Throttle(AUTH_THROTTLE)
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
  @Throttle(AUTH_THROTTLE)
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
  @Throttle(AUTH_THROTTLE)
  @ApiOperation({
    summary: 'Request a password reset link. Always returns 200 (no account enumeration).',
  })
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.auth.forgotPassword(dto.email);
    return { message: FORGOT_PASSWORD_MESSAGE };
  }

  @Post('reset-password')
  @HttpCode(200)
  @Throttle(AUTH_THROTTLE)
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

  /**
   * Starts SSO login (ADR 0003): redirects the browser to Azure AD. Entry
   * point for the ESS Portal launchpad tile — no request body, so a browser
   * navigation (not an XHR) is all a caller needs.
   */
  @Get('oidc/azure')
  @ApiOperation({ summary: 'Redirect to Azure AD to start a single sign-on login.' })
  async startAzureLogin(
    @Res() res: Response,
    @Query('returnTo') returnTo?: string,
  ): Promise<void> {
    // `returnTo` (optional) lets a trusted app (e.g. the ESS Portal) receive the
    // tokens at its own /auth/callback. It is allow-list-validated in the service;
    // an unlisted value is ignored (defaults to this app's web callback).
    const url = await this.azureOidc.buildAuthorizationUrl(returnTo);
    res.redirect(url);
  }

  /**
   * Completes SSO login: exchanges the code, resolves/creates the local user,
   * and hands the browser back to the web app with tokens in the URL FRAGMENT
   * (never a query string) so they never reach server logs or `Referer`
   * headers — the same pattern ESS Portal's own OIDC callback already uses.
   */
  @Get('oidc/azure/callback')
  @ApiOperation({ summary: 'Azure AD redirect target; completes single sign-on login.' })
  async azureCallback(
    @Query() query: Record<string, string>,
    @Res() res: Response,
    @ReqContext() ctx: RequestContext,
  ): Promise<void> {
    const defaultBase = (
      this.config.get<string>('WEB_APP_URL') ||
      this.config.get<string>('FRONTEND_URL') ||
      'http://localhost:5173'
    ).replace(/\/+$/, '');

    try {
      const profile = await this.azureOidc.handleCallback(query);
      const result = await this.auth.loginWithOidc(AZURE_OIDC_PROVIDER, profile);

      await this.audit.record({
        action: AUDIT_ACTIONS.USER_LOGIN_OIDC,
        actorUserId: result.user.id,
        targetType: 'user',
        ...ctx,
        metadata: { provider: AZURE_OIDC_PROVIDER, crossApp: !!profile.returnTo },
      });

      const fragment = new URLSearchParams({
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
      });
      // `profile.returnTo` (when present) is the caller's FULL, allow-list-validated
      // callback URL (e.g. https://portal.example.com/auth/pm-callback). Otherwise
      // fall back to this app's own web callback.
      const target = profile.returnTo ?? `${defaultBase}/auth/callback`;
      res.redirect(`${target}#${fragment.toString()}`);
    } catch (err) {
      await this.audit.record({
        action: AUDIT_ACTIONS.USER_LOGIN_OIDC_FAILED,
        targetType: 'user',
        ...ctx,
        metadata: { provider: AZURE_OIDC_PROVIDER },
      });
      res.redirect(`${defaultBase}/auth/callback#error=sso_failed`);
    }
  }
}
