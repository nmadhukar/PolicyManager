import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import type { AuthUser } from '@policymanager/shared';

const API_BASE = `${import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000'}/api`;
const REFRESH_KEY = 'pm_refresh';

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

/**
 * Access token lives ONLY in memory (never persisted) — reduces XSS blast radius.
 * The refresh token persists in localStorage so a page reload can silently
 * re-establish a session.
 */
let accessToken: string | null = null;
let onAuthFailure: (() => void) | null = null;

export const setAccessToken = (token: string | null): void => {
  accessToken = token;
};
export const getAccessToken = (): string | null => accessToken;

export const getRefreshToken = (): string | null => localStorage.getItem(REFRESH_KEY);
export const setRefreshToken = (token: string | null): void => {
  if (token) localStorage.setItem(REFRESH_KEY, token);
  else localStorage.removeItem(REFRESH_KEY);
};

/** Registered by AuthProvider so a hard refresh failure can clear app state. */
export const setOnAuthFailure = (cb: (() => void) | null): void => {
  onAuthFailure = cb;
};

/** Persists a successful auth result's tokens. */
export const storeSession = (result: AuthResult): void => {
  setAccessToken(result.accessToken);
  setRefreshToken(result.refreshToken);
};

export const clearSession = (): void => {
  setAccessToken(null);
  setRefreshToken(null);
};

export const http = axios.create({ baseURL: API_BASE });

/**
 * Refreshes using a BARE axios call (no interceptors) to avoid recursion.
 * Returns the new session or null on failure.
 */
export async function requestRefresh(): Promise<AuthResult | null> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return null;
  try {
    const { data } = await axios.post<AuthResult>(`${API_BASE}/auth/refresh`, { refreshToken });
    storeSession(data);
    return data;
  } catch {
    clearSession();
    return null;
  }
}

http.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  return config;
});

// De-duplicate concurrent refreshes triggered by parallel 401s.
let refreshInFlight: Promise<AuthResult | null> | null = null;

http.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const original = error.config as (InternalAxiosRequestConfig & { _retry?: boolean }) | undefined;
    const status = error.response?.status;

    if (status === 401 && original && !original._retry && getRefreshToken()) {
      original._retry = true;
      refreshInFlight = refreshInFlight ?? requestRefresh();
      const result = await refreshInFlight;
      refreshInFlight = null;

      if (result) {
        original.headers.Authorization = `Bearer ${result.accessToken}`;
        return http(original);
      }
      onAuthFailure?.();
    }
    return Promise.reject(error);
  },
);
