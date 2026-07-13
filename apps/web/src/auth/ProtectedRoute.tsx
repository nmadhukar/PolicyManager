import { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';

/**
 * Gates a route behind authentication. While the initial silent refresh is in
 * flight we render a neutral splash; unauthenticated users are redirected to
 * /login (preserving the attempted path). Authorization for specific actions is
 * still enforced server-side — this is UX routing, not security.
 */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return (
      <div className="grid min-h-screen place-items-center bg-slate-50 text-sm text-ink-muted">
        Loading…
      </div>
    );
  }

  if (status === 'unauthenticated') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
}
