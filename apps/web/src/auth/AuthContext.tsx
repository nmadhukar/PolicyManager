import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { AuthUser, PermissionKey } from '@policymanager/shared';
import { apiChangePassword, apiLogin, apiLogout, apiMe } from '../api/auth';
import {
  clearSession,
  requestRefresh,
  setAccessToken,
  setOnAuthFailure,
  setRefreshToken,
  storeSession,
} from '../api/http';

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

export interface AuthContextValue {
  user: AuthUser | null;
  status: AuthStatus;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /**
   * Changes the current user's password and persists the fresh session the API
   * returns (all prior sessions are revoked server-side). Clears the
   * must-change-password gate on success.
   */
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  /**
   * Completes an SSO login (ADR 0003): the callback page has already received
   * an access+refresh token pair from the OIDC redirect and just needs the
   * session persisted + the current user fetched, mirroring what `login` does
   * after a local password check.
   */
  completeSsoLogin: (accessToken: string, refreshToken: string) => Promise<void>;
  hasPermission: (key: PermissionKey) => boolean;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');

  const clearAuth = useCallback(() => {
    clearSession();
    setUser(null);
    setStatus('unauthenticated');
  }, []);

  // On boot, try to silently restore a session from the persisted refresh token.
  useEffect(() => {
    let active = true;
    (async () => {
      const result = await requestRefresh();
      if (!active) return;
      if (result) {
        setUser(result.user);
        setStatus('authenticated');
      } else {
        setStatus('unauthenticated');
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // If the http layer's refresh hard-fails mid-session, drop to logged-out.
  useEffect(() => {
    setOnAuthFailure(() => {
      setUser(null);
      setStatus('unauthenticated');
    });
    return () => setOnAuthFailure(null);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const result = await apiLogin(email, password);
    storeSession(result);
    setUser(result.user);
    setStatus('authenticated');
  }, []);

  const logout = useCallback(async () => {
    await apiLogout();
    clearAuth();
  }, [clearAuth]);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    const result = await apiChangePassword(currentPassword, newPassword);
    // Persist the fresh tokens so the session survives the server-side revocation.
    storeSession(result);
    setUser(result.user);
    setStatus('authenticated');
  }, []);

  const completeSsoLogin = useCallback(async (accessToken: string, refreshToken: string) => {
    setAccessToken(accessToken);
    setRefreshToken(refreshToken);
    const me = await apiMe();
    setUser(me);
    setStatus('authenticated');
  }, []);

  const hasPermission = useCallback(
    (key: PermissionKey) => !!user?.permissions.includes(key),
    [user],
  );

  const value = useMemo<AuthContextValue>(
    () => ({ user, status, login, logout, changePassword, completeSsoLogin, hasPermission }),
    [user, status, login, logout, changePassword, completeSsoLogin, hasPermission],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
