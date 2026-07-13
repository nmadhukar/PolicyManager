import { FormEvent, useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { AxiosError } from 'axios';
import { useAuth } from '../auth/AuthContext';
import { AuthBrand, AuthCard } from '../ui/AuthLayout';

export function LoginPage() {
  const { status, login } = useAuth();
  const location = useLocation();
  const locationState = location.state as { from?: string; resetSuccess?: boolean } | null;
  const from = locationState?.from ?? '/';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (status === 'authenticated') {
    return <Navigate to={from} replace />;
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email.trim(), password);
    } catch (err) {
      const errStatus = (err as AxiosError).response?.status;
      setError(
        errStatus === 401
          ? 'Invalid email or password, or the account is locked.'
          : 'Unable to sign in right now. Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthCard>
      <AuthBrand
        title="Sign in to PolicyManager"
        subtitle="Behavioral Health Document Management"
      />

      <form className="card space-y-4 p-6" onSubmit={onSubmit} noValidate>
        {locationState?.resetSuccess && !error && (
          <div
            className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800"
            role="status"
          >
            Your password has been reset. Sign in with your new password.
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            {error}
          </div>
        )}

        <div>
          <label htmlFor="email" className="label">
            Email
          </label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            className="input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
        </div>

        <div>
          <div className="flex items-center justify-between">
            <label htmlFor="password" className="label">
              Password
            </label>
            <Link
              to="/forgot-password"
              className="mb-1 text-xs font-medium text-brand-600 hover:underline"
            >
              Forgot password?
            </Link>
          </div>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>

        <button type="submit" className="btn-primary w-full" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </AuthCard>
  );
}
