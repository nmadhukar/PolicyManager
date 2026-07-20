import type { LibraryView } from './types';

export function ViewTabs({
  view,
  onChange,
  canWrite,
}: {
  view: LibraryView;
  onChange: (v: LibraryView) => void;
  canWrite: boolean;
}) {
  const tabs: { key: LibraryView; label: string }[] = [
    { key: 'active', label: 'Active' },
    { key: 'archived', label: 'Archived' },
    ...(canWrite ? [{ key: 'trash' as const, label: 'Trash' }] : []),
  ];
  return (
    <div
      className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5"
      role="tablist"
      aria-label="Library view"
    >
      {tabs.map((t) => {
        const active = view === t.key;
        return (
          <button
            key={t.key}
            role="tab"
            aria-selected={active}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
              active ? 'bg-brand-600 text-white' : 'text-ink-soft hover:bg-slate-50'
            }`}
            onClick={() => onChange(t.key)}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
