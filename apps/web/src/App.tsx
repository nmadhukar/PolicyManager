import { AppShell } from './ui/AppShell';

export default function App() {
  return (
    <AppShell>
      <div className="mx-auto max-w-3xl">
        <h1 className="text-2xl font-semibold text-ink">Welcome to PolicyManager</h1>
        <p className="mt-2 text-ink-muted">
          A single, versioned, access-controlled home for your clinic's policies, procedures,
          job descriptions, and IOP/PHP curriculums — built for CARF and Joint Commission
          compliance.
        </p>
        <div className="mt-6 card p-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
            Getting started
          </h2>
          <ul className="mt-3 space-y-2 text-sm text-ink-soft">
            <li>• Sign in to access the document library.</li>
            <li>• Upload and version controlled documents.</li>
            <li>• Schedule quarterly / annual reviews and capture sign-offs.</li>
          </ul>
        </div>
      </div>
    </AppShell>
  );
}
