import type { AuthUser } from '@policymanager/shared';
import { AuthResult, getRefreshToken, http } from './http';

export async function apiLogin(email: string, password: string): Promise<AuthResult> {
  const { data } = await http.post<AuthResult>('/auth/login', { email, password });
  return data;
}

export async function apiMe(): Promise<AuthUser> {
  const { data } = await http.get<AuthUser>('/auth/me');
  return data;
}

/** Requests a reset link. The API always responds 200 (no account enumeration). */
export async function apiForgotPassword(email: string): Promise<void> {
  await http.post('/auth/forgot-password', { email });
}

/** Completes a reset using the emailed token. */
export async function apiResetPassword(token: string, newPassword: string): Promise<void> {
  await http.post('/auth/reset-password', { token, newPassword });
}

/**
 * Authenticated password change. Returns a FRESH session (all prior refresh
 * tokens are revoked server-side), so the caller must persist the new tokens.
 */
export async function apiChangePassword(
  currentPassword: string,
  newPassword: string,
): Promise<AuthResult> {
  const { data } = await http.post<AuthResult>('/auth/change-password', {
    currentPassword,
    newPassword,
  });
  return data;
}

export async function apiLogout(): Promise<void> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return;
  // Best-effort revoke; ignore network/status errors so local logout always proceeds.
  try {
    await http.post('/auth/logout', { refreshToken });
  } catch {
    /* no-op */
  }
}
