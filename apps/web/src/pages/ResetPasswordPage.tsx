import { FormEvent, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AxiosError } from 'axios';
import { PASSWORD_POLICY_HINTS, validatePassword } from '@policymanager/shared';
import { apiResetPassword } from '../api/auth';
import { AuthBrand, AuthCard } from '../ui/AuthLayout';
import { PasswordHints } from '../ui/PasswordHints';

/**
 * Public "set a new password" screen reached from the emailed link
 * (/reset-password?token=...). Enforces the shared password policy client-side
 * for fast feedback; the server re-validates authoritatively.
 */
export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const policyErrors = validatePassword(password);
  const mismatch = confirm.length > 0 && confirm !== password;
  const canSubmit = !!token && policyErrors.length === 0 && !mismatch && confirm.length > 0;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await apiResetPassword(token, password);
      // Land on login with a one-time success banner.
      navigate('/login', { replace: true, state: { resetSuccess: true } });
    } catch (err) {
      const status = (err as AxiosError).response?.status;
      setError(
        status === 400
          ? 'This reset link is invalid or has expired. Request a new one.'
          : 'Unable to reset your password right now. Please try again.',
      );
      setSubmitting(false);
    }
  };

  if (!token) {
    return (
      <AuthCard>
        <AuthBrand title="Reset link problem" />
        <div className="card space-y-4 p-6">
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            This reset link is missing its token. Please use the most recent link from your email.
          </div>
          <Link to="/forgot-password" className="btn-primary w-full">
            Request a new link
          </Link>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard>
      <AuthBrand title="Choose a new password" subtitle="Set the password for your account" />

      <form className="card space-y-4 p-6" onSubmit={onSubmit} noValidate>
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            {error}
          </div>
        )}

        <div>
          <label htmlFor="password" className="label">
            New password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="new-password"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoFocus
          />
          <PasswordHints hints={PASSWORD_POLICY_HINTS} value={password} />
        </div>

        <div>
          <label htmlFor="confirm" className="label">
            Confirm new password
          </label>
          <input
            id="confirm"
            type="password"
            autoComplete="new-password"
            className="input"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
          {mismatch && (
            <p className="mt-1 text-xs text-red-600" role="alert">
              Passwords do not match.
            </p>
          )}
        </div>

        <button type="submit" className="btn-primary w-full" disabled={submitting || !canSubmit}>
          {submitting ? 'Saving…' : 'Set new password'}
        </button>

        <p className="text-center text-sm text-ink-muted">
          <Link to="/login" className="font-medium text-brand-600 hover:underline">
            Back to sign in
          </Link>
        </p>
      </form>
    </AuthCard>
  );
}
