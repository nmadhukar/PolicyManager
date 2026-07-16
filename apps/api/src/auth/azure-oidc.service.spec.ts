import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AzureOidcService } from './azure-oidc.service';

/**
 * Guard-rail tests for ADR 0003's "disabled provider cannot be used" and
 * state single-use/expiry requirements. The Azure discovery/token-exchange
 * network calls are intentionally NOT exercised here (would require a live or
 * mocked Azure AD endpoint); those are covered by manual/e2e verification
 * per the ADR.
 *
 * @nestjs/config's ConfigService gives `process.env` PRECEDENCE over the
 * constructor object (see auth.service.spec.ts's note on the same gotcha), and
 * the repo `.env` pins OIDC_ENABLED=false — so tests that need it "true" must
 * override `process.env.OIDC_ENABLED` directly, restored in `afterEach`.
 */
describe('AzureOidcService', () => {
  const originalOidcEnabled = process.env.OIDC_ENABLED;
  afterEach(() => {
    process.env.OIDC_ENABLED = originalOidcEnabled;
  });

  const makePrisma = () => ({
    oidcState: { create: jest.fn(), findUnique: jest.fn(), delete: jest.fn() },
  });

  const build = (
    prisma: ReturnType<typeof makePrisma>,
    env: Record<string, string> = {},
  ) => {
    if (env.OIDC_ENABLED !== undefined) {
      process.env.OIDC_ENABLED = env.OIDC_ENABLED;
    }
    return new AzureOidcService(new ConfigService(env) as never, prisma as never);
  };

  describe('isEnabled', () => {
    it('is false by default', () => {
      const service = build(makePrisma(), {});
      expect(service.isEnabled()).toBe(false);
    });

    it('is true only when OIDC_ENABLED="true"', () => {
      const service = build(makePrisma(), { OIDC_ENABLED: 'true' });
      expect(service.isEnabled()).toBe(true);
    });
  });

  describe('validateReturnTo (cross-app SSO allow-list)', () => {
    const svc = (env: Record<string, string> = {}) => build(makePrisma(), env);

    it('returns null for undefined/empty/malformed input', () => {
      const s = svc({ FRONTEND_URL: 'http://localhost:5173' });
      expect(s.validateReturnTo(undefined)).toBeNull();
      expect(s.validateReturnTo('')).toBeNull();
      expect(s.validateReturnTo('not a url')).toBeNull();
    });

    it("allows this app's own FRONTEND_URL / WEB_APP_URL origin (keeps the path)", () => {
      const s = svc({ FRONTEND_URL: 'http://localhost:5173' });
      // Full callback URL preserved (origin validated, path kept, trailing slash trimmed).
      expect(s.validateReturnTo('http://localhost:5173/auth/callback')).toBe(
        'http://localhost:5173/auth/callback',
      );
      // A bare origin normalizes to just the origin.
      expect(s.validateReturnTo('http://localhost:5173/')).toBe('http://localhost:5173');
    });

    it('allows a full callback URL on an allow-listed origin (e.g. the ESS Portal)', () => {
      const s = svc({
        FRONTEND_URL: 'http://localhost:5173',
        SSO_ALLOWED_RETURN_ORIGINS: 'https://portal.example.com, http://localhost:5200',
      });
      // The caller names its OWN callback path; we keep it (origin is allow-listed).
      expect(s.validateReturnTo('http://localhost:5200/auth/pm-callback')).toBe(
        'http://localhost:5200/auth/pm-callback',
      );
      expect(s.validateReturnTo('https://portal.example.com/auth/pm-callback?x=1#y')).toBe(
        'https://portal.example.com/auth/pm-callback',
      );
    });

    it('REJECTS an unlisted origin (security: no open redirect)', () => {
      const s = svc({
        FRONTEND_URL: 'http://localhost:5173',
        SSO_ALLOWED_RETURN_ORIGINS: 'https://portal.example.com',
      });
      expect(s.validateReturnTo('https://evil.example.com/steal')).toBeNull();
      expect(s.validateReturnTo('http://localhost:9999')).toBeNull();
    });
  });

  describe('disabled provider', () => {
    it('buildAuthorizationUrl refuses when OIDC_ENABLED is not "true"', async () => {
      const prisma = makePrisma();
      const service = build(prisma, { OIDC_ENABLED: 'false' });
      await expect(service.buildAuthorizationUrl()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(prisma.oidcState.create).not.toHaveBeenCalled();
    });

    it('handleCallback refuses when OIDC_ENABLED is not "true"', async () => {
      const prisma = makePrisma();
      const service = build(prisma, { OIDC_ENABLED: 'false' });
      await expect(service.handleCallback({ state: 'x', code: 'y' })).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(prisma.oidcState.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('handleCallback state validation', () => {
    it('rejects a callback with no state param', async () => {
      const service = build(makePrisma(), { OIDC_ENABLED: 'true' });
      await expect(service.handleCallback({ code: 'y' })).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects an unknown state (never issued, or already consumed)', async () => {
      const prisma = makePrisma();
      prisma.oidcState.findUnique.mockResolvedValue(null);
      const service = build(prisma, { OIDC_ENABLED: 'true' });

      await expect(
        service.handleCallback({ state: 'never-issued', code: 'y' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('deletes the state row on first use so it cannot be replayed', async () => {
      const prisma = makePrisma();
      prisma.oidcState.findUnique.mockResolvedValue({
        id: 'row-1',
        state: 'abc',
        nonce: 'n',
        codeVerifier: 'v',
        redirectUri: 'http://x',
        expiresAt: new Date(Date.now() + 60_000),
      });
      prisma.oidcState.delete.mockResolvedValue({});
      const service = build(prisma, {
        OIDC_ENABLED: 'true',
        OIDC_AZURE_ISSUER: 'https://login.microsoftonline.com/test/v2.0',
        OIDC_AZURE_CLIENT_ID: 'client',
        OIDC_AZURE_CLIENT_SECRET: 'secret',
        OIDC_CALLBACK_BASE_URL: 'http://localhost:3000',
      });

      // The token exchange itself will fail (no live Azure endpoint) — that's
      // fine; what this test verifies is that the state row is deleted BEFORE
      // the exchange is attempted, so a captured callback URL can't be replayed
      // even if the caller retries after a failure.
      await expect(service.handleCallback({ state: 'abc', code: 'y' })).rejects.toThrow();
      expect(prisma.oidcState.delete).toHaveBeenCalledWith({ where: { id: 'row-1' } });
    });

    it('rejects an expired state', async () => {
      const prisma = makePrisma();
      prisma.oidcState.findUnique.mockResolvedValue({
        id: 'row-1',
        state: 'abc',
        nonce: 'n',
        codeVerifier: 'v',
        redirectUri: 'http://x',
        expiresAt: new Date(Date.now() - 1),
      });
      prisma.oidcState.delete.mockResolvedValue({});
      const service = build(prisma, { OIDC_ENABLED: 'true' });

      await expect(service.handleCallback({ state: 'abc', code: 'y' })).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });
  });
});
