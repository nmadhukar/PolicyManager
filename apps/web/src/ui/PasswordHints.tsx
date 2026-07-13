import { validatePassword } from '@policymanager/shared';

/**
 * Shows the password requirements and, once the user starts typing, the concrete
 * outstanding violations (from the shared validator, so hints match server rules).
 */
export function PasswordHints({
  hints,
  value,
}: {
  hints: readonly string[];
  value: string;
}) {
  const errors = value.length > 0 ? validatePassword(value) : [];

  return (
    <div className="mt-1.5">
      <ul className="space-y-0.5 text-xs text-ink-muted">
        {hints.map((h) => (
          <li key={h} className="flex items-center gap-1.5">
            <span aria-hidden>•</span>
            {h}
          </li>
        ))}
      </ul>
      {errors.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-xs text-amber-600" aria-live="polite">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
