import { ReactNode } from 'react';

/**
 * The single reusable content-card shell for the document-detail 2x2 grid.
 * Owns the .card chrome, an icon+title header (with an optional muted subtitle
 * and a right-aligned action slot), and equal-height behavior via `flex h-full
 * flex-col` so two cards in a grid row match heights. These are content cards,
 * not clickable — no hover treatment. Merged quadrants stack two panel bodies
 * separated by <CardSection divider>.
 */
export function SectionCard({
  icon,
  title,
  subtitle,
  action,
  children,
  className = '',
}: {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card flex h-full flex-col p-5 ${className}`}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <span
            aria-hidden
            className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600"
          >
            {icon}
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
              {title}
            </h2>
            {subtitle && <p className="mt-0.5 text-xs text-ink-muted">{subtitle}</p>}
          </div>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {/* min-w-0 keeps wide inner content (tables, long grants) from overflowing. */}
      <div className="min-w-0 flex-1 space-y-4">{children}</div>
    </section>
  );
}

/**
 * A sub-section inside a SectionCard. `divider` draws the existing
 * `border-t border-slate-100 pt-4` rule above it — used to separate a merged
 * card's two halves. `title` renders the existing <h3> sub-header idiom with an
 * optional right-aligned action; omit it for a bare block.
 */
export function CardSection({
  title,
  action,
  divider = false,
  children,
}: {
  title?: string;
  action?: ReactNode;
  divider?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={divider ? 'border-t border-slate-100 pt-4' : ''}>
      {(title || action) && (
        <div className="mb-2 flex items-center justify-between gap-3">
          {title && (
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
              {title}
            </h3>
          )}
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

/* Hand-rolled inline icons matching the app's convention: viewBox 0 0 20 20,
 * fill none, stroke currentColor (inherits brand-600 from the SectionCard chip),
 * strokeWidth 1.6, rounded caps/joins, sized h-4 w-4. */

/** Q1 Details — a document sheet with lines. */
export function DetailsIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M5 2.5h6l4 4V17a.5.5 0 0 1-.5.5h-9A.5.5 0 0 1 5 17V3a.5.5 0 0 1 .5-.5Z" />
      <path d="M11 2.5V6a.5.5 0 0 0 .5.5H15" />
      <path d="M7.5 10.5h5M7.5 13.5h5" />
    </svg>
  );
}

/** Q2 Governance — a shield with a check (compliance / sign-off). */
export function GovernanceIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M10 2.5 4 5v4.5c0 3.5 2.4 6.4 6 8 3.6-1.6 6-4.5 6-8V5l-6-2.5Z" />
      <path d="m7.5 9.8 1.8 1.8L13 8" />
    </svg>
  );
}

/** Q3 Staff acknowledgment — people (group sign-off). */
export function AcknowledgmentIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="7.5" cy="7" r="2.5" />
      <path d="M3 16c0-2.5 2-4.2 4.5-4.2S12 13.5 12 16" />
      <path d="M13 5.2A2.3 2.3 0 0 1 13 9.6" />
      <path d="M13.2 11.9c2 .4 3.3 2 3.3 4.1" />
    </svg>
  );
}

/** Q4 Access control — a padlock. */
export function AccessIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="4.5" y="8.5" width="11" height="8" rx="1.5" />
      <path d="M7 8.5V6a3 3 0 0 1 6 0v2.5" />
      <circle cx="10" cy="12.3" r="1" />
      <path d="M10 13.3v1.4" />
    </svg>
  );
}
