import { ReactNode } from 'react';

const NAV = [
  { label: 'Dashboard', icon: '▚' },
  { label: 'Library', icon: '▤' },
  { label: 'Reviews', icon: '◷' },
  { label: 'Acknowledgments', icon: '✓' },
  { label: 'Admin', icon: '⚙' },
];

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-slate-200 bg-white md:flex">
        <div className="flex h-16 items-center gap-2 border-b border-slate-200 px-5">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-600 text-sm font-bold text-white">
            PM
          </span>
          <span className="font-semibold text-ink">PolicyManager</span>
        </div>
        <nav className="flex-1 space-y-1 p-3">
          {NAV.map((item) => (
            <a
              key={item.label}
              href="#"
              className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-ink-soft hover:bg-slate-100"
            >
              <span aria-hidden className="text-ink-muted">
                {item.icon}
              </span>
              {item.label}
            </a>
          ))}
        </nav>
        <div className="border-t border-slate-200 p-4 text-xs text-ink-muted">
          CARF / Joint Commission ready
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 items-center justify-between border-b border-slate-200 bg-white px-6">
          <div className="text-sm text-ink-muted">Behavioral Health Document Management</div>
          <div className="flex items-center gap-3">
            <button className="btn-secondary">Sign in</button>
          </div>
        </header>
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
