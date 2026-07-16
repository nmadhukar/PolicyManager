import { Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { custom, generators, Issuer, type Client } from 'openid-client';
import { PrismaService } from '../prisma/prisma.service';

/** Azure AD provider key stored on `UserIdentity.provider` / audit metadata. */
export const AZURE_OIDC_PROVIDER = 'azure';

/**
 * openid-client's built-in default request timeout (3.5s) is too aggressive
 * for a cold first connection to Azure AD (DNS + TLS negotiation on the very
 * first outbound request from a freshly started container/process routinely
 * exceeds it, even though a warm connection is well under a second). Applies
 * to every request the library makes (discovery, token exchange, etc.).
 */
custom.setHttpOptionsDefaults({ timeout: 15_000 });

/** How long an in-flight login (state/nonce/PKCE) stays valid (ADR 0003 §6). */
const OIDC_STATE_TTL_MS = 10 * 60_000;

/** Claims this app reads off a validated Azure AD ID token. */
export interface AzureOidcProfile {
  /** Azure AD `oid` claim — stable per-user identifier within the tenant. */
  subject: string;
  email: string;
  /** Whether Azure AD asserts the email claim is verified. */
  emailVerified: boolean;
  name: string;
  /** Allow-listed origin to hand tokens back to (null = default web app). */
  returnTo?: string | null;
}

/**
 * Azure AD / Entra OIDC client (ADR 0003). Wraps `openid-client`'s Authorization
 * Code + PKCE flow: builds the redirect to Azure AD, and on the way back
 * exchanges the code + validates the ID token. State/nonce/PKCE verifier are
 * persisted in `OidcState` (not Redis — this app has none; see ADR 0003 §6) so
 * the flow survives across the redirect without relying on a session cookie.
 *
 * The discovered `Client` is cached after first use since Azure's discovery
 * document does not change at runtime.
 */
@Injectable()
export class AzureOidcService {
  private readonly logger = new Logger(AzureOidcService.name);
  private client: Client | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  isEnabled(): boolean {
    return String(this.configService.get('OIDC_ENABLED', 'false')) === 'true';
  }

  private requireEnabled(): void {
    if (!this.isEnabled()) {
      throw new ServiceUnavailableException('Single sign-on is not enabled.');
    }
  }

  /** Lazily discovers and caches the Azure AD OIDC client. */
  private async getClient(): Promise<Client> {
    if (this.client) return this.client;

    const issuerUrl = this.configService.getOrThrow<string>('OIDC_AZURE_ISSUER');
    const clientId = this.configService.getOrThrow<string>('OIDC_AZURE_CLIENT_ID');
    const clientSecret = this.configService.getOrThrow<string>('OIDC_AZURE_CLIENT_SECRET');

    const issuer = await Issuer.discover(issuerUrl);
    this.client = new issuer.Client({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uris: [this.callbackUrl()],
      response_types: ['code'],
    });
    return this.client;
  }

  private callbackUrl(): string {
    const base = this.configService.getOrThrow<string>('OIDC_CALLBACK_BASE_URL');
    return `${base.replace(/\/+$/, '')}/api/auth/oidc/azure/callback`;
  }

  private scopes(): string {
    return this.configService.get<string>('OIDC_AZURE_SCOPES', 'openid profile email');
  }

  /**
   * Web origins allowed to receive SSO tokens via `returnTo`. PolicyManager's own
   * web app is always allowed; additional trusted apps (the ESS Portal) are added
   * via SSO_ALLOWED_RETURN_ORIGINS (comma-separated). An unlisted origin is
   * ignored (falls back to the default web app), so a captured start URL can't
   * redirect tokens to an attacker's site.
   */
  private allowedReturnOrigins(): string[] {
    const own = [
      this.configService.get<string>('WEB_APP_URL'),
      this.configService.get<string>('FRONTEND_URL'),
    ];
    const extra = (this.configService.get<string>('SSO_ALLOWED_RETURN_ORIGINS') || '').split(',');
    return [...own, ...extra]
      .filter((v): v is string => !!v)
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter(Boolean);
  }

  /**
   * Validates a caller-supplied `returnTo` against the allow-list. The value may
   * be a bare origin OR a full callback URL (origin + path); we validate the
   * ORIGIN against the allow-list but return the FULL normalized URL (minus any
   * trailing slash), so a trusted app can name its own callback path
   * (e.g. https://portal.example.com/auth/pm-callback). Returns null if the origin
   * is not allow-listed or the input isn't a valid absolute URL — preventing an
   * open redirect. Query/fragment are stripped (tokens are appended as a fragment).
   */
  validateReturnTo(returnTo: string | undefined): string | null {
    if (!returnTo) return null;
    let url: URL;
    try {
      url = new URL(returnTo);
    } catch {
      return null;
    }
    if (!this.allowedReturnOrigins().includes(url.origin)) return null;
    // Keep only origin + path (drop query/hash); strip a trailing slash.
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  }

  /**
   * Starts a login: persists state/nonce/PKCE, returns the Azure AD authorize
   * URL to redirect the browser to. `returnTo` (an allow-listed origin) lets a
   * second trusted app receive the tokens at its own /auth/callback.
   */
  async buildAuthorizationUrl(returnTo?: string): Promise<string> {
    this.requireEnabled();
    const client = await this.getClient();

    const codeVerifier = generators.codeVerifier();
    const codeChallenge = generators.codeChallenge(codeVerifier);
    const state = generators.state();
    const nonce = generators.nonce();

    await this.prisma.oidcState.create({
      data: {
        state,
        nonce,
        codeVerifier,
        redirectUri: this.callbackUrl(),
        returnTo: this.validateReturnTo(returnTo),
        expiresAt: new Date(Date.now() + OIDC_STATE_TTL_MS),
      },
    });

    return client.authorizationUrl({
      scope: this.scopes(),
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
  }

  /**
   * Completes a login: validates `state` (single-use — the row is deleted
   * whether or not the exchange succeeds, so a captured callback URL cannot be
   * replayed), exchanges the code, and validates the ID token (issuer,
   * audience, nonce, expiry — all enforced by `openid-client`).
   */
  async handleCallback(params: Record<string, string>): Promise<AzureOidcProfile> {
    this.requireEnabled();

    const state = params.state;
    if (!state) {
      throw new UnauthorizedException('Missing OIDC state.');
    }

    const record = await this.prisma.oidcState.findUnique({ where: { state } });
    // Delete immediately (found or not) so a state value is usable at most once.
    if (record) {
      await this.prisma.oidcState.delete({ where: { id: record.id } }).catch(() => undefined);
    }
    if (!record || record.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('This sign-in attempt has expired. Please try again.');
    }

    const client = await this.getClient();
    let tokenSet;
    try {
      tokenSet = await client.callback(this.callbackUrl(), params, {
        state,
        nonce: record.nonce,
        code_verifier: record.codeVerifier,
      });
    } catch (err) {
      this.logger.warn(`Azure AD token exchange failed: ${(err as Error).message}`);
      throw new UnauthorizedException('Sign-in with Microsoft failed.');
    }

    const claims = tokenSet.claims();
    const email = (claims.email as string | undefined) ?? (claims.preferred_username as string | undefined);
    if (!email) {
      throw new UnauthorizedException('Your Microsoft account has no email address on file.');
    }

    return {
      subject: claims.sub,
      email: email.toLowerCase().trim(),
      // Azure AD does not emit a standard `email_verified` claim for work/school
      // accounts; organizational email is managed by the tenant admin, so treat
      // any Azure-asserted email as verified for account-linking purposes.
      emailVerified: true,
      name: (claims.name as string | undefined) ?? email,
      // Re-validate against the current allow-list at callback time (defence in
      // depth: the allow-list could have tightened since login started).
      returnTo: this.validateReturnTo(record.returnTo ?? undefined),
    };
  }
}
