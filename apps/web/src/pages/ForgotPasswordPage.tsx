import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiForgotPassword } from '../api/auth';
import { AuthBrand, AuthCard } from '../ui/AuthLayout';

/**
 * Public "forgot password" screen. The API never reveals whether an account
 * exists, so on a successful request we always show the same neutral message.
 */
export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await apiForgotPassword(email.trim());
      setSubmitted(true);
    } catch {
      setError('Unable to submit your request right now. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthCard>
      <AuthBrand
        title="Reset your password"
        subtitle="We'll email you a link to set a new one"
      />

      {submitted ? (
        <div className="card space-y-4 p-6">
          <div
            className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800"
            role="status"
          >
            If an account exists for <span className="font-medium">{email}</span>, a password reset
            link is on its way. The link expires in 30 minutes.
          </div>
          <p className="text-sm text-ink-muted">
            Didn&apos;t get it? Check your spam folder, or{' '}
            <button
              type="button"
              className="font-medium text-brand-600 hover:underline"
              onClick={() => setSubmitted(false)}
            >
              try a different email
            </button>
            .
          </p>
          <Link to="/login" className="btn-secondary w-full">
            Back to sign in
          </Link>
        </div>
      ) : (
        <form className="card space-y-4 p-6" onSubmit={onSubmit} noValidate>
          {error && (
            <div
              className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
              role="alert"
            >
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

          <button type="submit" className="btn-primary w-full" disabled={submitting}>
            {submitting ? 'Sending…' : 'Send reset link'}
          </button>

          <p className="text-center text-sm text-ink-muted">
            <Link to="/login" className="font-medium text-brand-600 hover:underline">
              Back to sign in
            </Link>
          </p>
        </form>
      )}
    </AuthCard>
  );
}
