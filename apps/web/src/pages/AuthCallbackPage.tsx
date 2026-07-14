import { useEffect, useRef, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { AuthBrand, AuthCard } from '../ui/AuthLayout';

/**
 * Landing page for the Azure AD SSO redirect (ADR 0003). The API hands the
 * browser back here with tokens in the URL FRAGMENT — never a query string —
 * so they never reach server logs or `Referer` headers. We read them, scrub
 * the URL immediately (a fragment left in the address bar is one screen-share
 * away from leaking a live session), then complete the login exactly like the
 * local-password form does after a successful check.
 */
export function AuthCallbackPage() {
  const { status, completeSsoLogin } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    // Scrub the fragment now, before anything else runs, regardless of outcome.
    window.history.replaceState(null, '', window.location.pathname);

    const oidcError = fragment.get('error');
    const accessToken = fragment.get('accessToken');
    const refreshToken = fragment.get('refreshToken');

    if (oidcError || !accessToken || !refreshToken) {
      setError('Sign-in with Microsoft failed. Please try again or use your password.');
      return;
    }

    completeSsoLogin(accessToken, refreshToken).catch(() => {
      setError('Sign-in with Microsoft failed. Please try again or use your password.');
    });
  }, [completeSsoLogin]);

  if (status === 'authenticated') {
    return <Navigate to="/" replace />;
  }

  return (
    <AuthCard>
      <AuthBrand title="Signing you in…" subtitle="Completing sign-in with Microsoft" />
      <div className="card space-y-4 p-6">
        {error ? (
          <>
            <div
              className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
              role="alert"
            >
              {error}
            </div>
            <Link to="/login" className="btn-secondary w-full">
              Back to sign in
            </Link>
          </>
        ) : (
          <p className="text-center text-sm text-ink-muted">One moment…</p>
        )}
      </div>
    </AuthCard>
  );
}
