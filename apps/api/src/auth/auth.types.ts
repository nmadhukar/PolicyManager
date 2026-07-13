import type { AuthUser } from '@policymanager/shared';

/**
 * Shape of the signed JWT access-token payload.
 * `sub` is the user id; `email` is included for convenience/logging.
 */
export interface JwtPayload {
  sub: string;
  email: string;
}

/**
 * Tokens returned to a client after login/refresh.
 * The refresh token is the RAW opaque value — only its hash is persisted.
 */
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

/** Login/refresh response contract. */
export interface AuthResult extends AuthTokens {
  user: AuthUser;
}
