import { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';

/**
 * Gates a route behind authentication. While the initial silent refresh is in
 * flight we render a neutral splash; unauthenticated users are redirected to
 * /login (preserving the attempted path). Authorization for specific actions is
 * still enforced server-side — this is UX routing, not security.
 *
 * When the account is flagged `mustChangePassword` (temp password / admin reset),
 * every protected route funnels to /change-password until the change is done.
 */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { status, user } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return (
      <div className="grid min-h-screen place-items-center bg-slate-50 text-sm text-ink-muted">
        Loading…
      </div>
    );
  }

  if (status === 'unauthenticated') {
    // Preserve the attempted path both in router state (SPA redirect) and as a
    // ?from= query param, so it survives a full page reload after a refresh
    // failure (state is lost on reload; the query param isn't).
    const from = location.pathname + location.search;
    return (
      <Navigate
        to={{
          pathname: '/login',
          search: from !== '/' ? `?from=${encodeURIComponent(from)}` : '',
        }}
        replace
        state={{ from }}
      />
    );
  }

  if (user?.mustChangePassword && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />;
  }

  return <>{children}</>;
}
