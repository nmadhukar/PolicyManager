import { ReactNode } from 'react';

/** Full-screen centered container shared by the public auth screens. */
export function AuthCard({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center bg-slate-50 px-4">
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}

/** Brand mark + title + subtitle header shared by the public auth screens. */
export function AuthBrand({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-6 flex flex-col items-center gap-2 text-center">
      <span className="grid h-11 w-11 place-items-center rounded-xl bg-brand-600 text-lg font-bold text-white">
        PM
      </span>
      <h1 className="text-lg font-semibold text-ink">{title}</h1>
      {subtitle && <p className="text-sm text-ink-muted">{subtitle}</p>}
    </div>
  );
}
