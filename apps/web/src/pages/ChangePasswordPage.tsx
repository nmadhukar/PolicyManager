import { FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AxiosError } from 'axios';
import { PASSWORD_POLICY_HINTS, validatePassword } from '@policymanager/shared';
import { useAuth } from '../auth/AuthContext';
import { AppShell } from '../ui/AppShell';
import { AuthBrand, AuthCard } from '../ui/AuthLayout';
import { PasswordHints } from '../ui/PasswordHints';

/**
 * Authenticated password change. When the account is flagged
 * `mustChangePassword` (temp password / admin reset) this renders as a focused,
 * unavoidable screen; otherwise it renders inside the app shell as a normal
 * account action.
 */
export function ChangePasswordPage() {
  const { user, logout } = useAuth();
  const forced = !!user?.mustChangePassword;

  if (forced) {
    return (
      <AuthCard>
        <AuthBrand title="Update your password" subtitle="Required before you continue" />
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          For security, you must choose a new password before using PolicyManager.
        </div>
        <ChangePasswordForm forced />
        <p className="mt-4 text-center text-sm text-ink-muted">
          <button
            type="button"
            className="font-medium text-brand-600 hover:underline"
            onClick={() => void logout()}
          >
            Sign out
          </button>
        </p>
      </AuthCard>
    );
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-md">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-ink">Change password</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Update the password you use to sign in to PolicyManager.
          </p>
        </div>
        <ChangePasswordForm />
      </div>
    </AppShell>
  );
}

function ChangePasswordForm({ forced = false }: { forced?: boolean }) {
  const { changePassword } = useAuth();
  const navigate = useNavigate();

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const policyErrors = validatePassword(next);
  const mismatch = confirm.length > 0 && confirm !== next;
  const canSubmit =
    current.length > 0 && policyErrors.length === 0 && !mismatch && confirm.length > 0;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await changePassword(current, next);
      if (forced) {
        // Gate is now cleared — proceed into the app.
        navigate('/', { replace: true });
      } else {
        setDone(true);
      }
    } catch (err) {
      const status = (err as AxiosError).response?.status;
      setError(
        status === 400
          ? 'Your current password is incorrect, or the new password is not allowed.'
          : 'Unable to change your password right now. Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <div className="card space-y-4 p-6">
        <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800" role="status">
          Your password has been updated. Other active sessions have been signed out.
        </div>
        <Link to="/" className="btn-primary">
          Back to dashboard
        </Link>
      </div>
    );
  }

  return (
    <form className="card space-y-4 p-6" onSubmit={onSubmit} noValidate>
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </div>
      )}

      <div>
        <label htmlFor="current" className="label">
          Current password
        </label>
        <input
          id="current"
          type="password"
          autoComplete="current-password"
          className="input"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          required
          autoFocus
        />
      </div>

      <div>
        <label htmlFor="next" className="label">
          New password
        </label>
        <input
          id="next"
          type="password"
          autoComplete="new-password"
          className="input"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          required
        />
        <PasswordHints hints={PASSWORD_POLICY_HINTS} value={next} />
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
        {submitting ? 'Updating…' : 'Update password'}
      </button>
    </form>
  );
}
