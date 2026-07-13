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
