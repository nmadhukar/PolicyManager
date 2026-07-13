import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { PERMISSIONS, type StorageBucket } from '@policymanager/shared';
import {
  createBucket,
  createPrefix,
  getStorageConfig,
  listBuckets,
  listPrefixes,
} from '../api/storage';
import { useAuth } from '../auth/AuthContext';
import { AppShell } from '../ui/AppShell';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { EmptyState, ErrorState, ForbiddenState, LoadingState } from '../ui/states';

export function StorageAdminPage() {
  const { hasPermission } = useAuth();
  return (
    <AppShell>
      <div className="mx-auto max-w-5xl">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-ink">Storage</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Administer object-storage buckets and folders. Buckets are created private and
            versioned; there are no destructive operations here.
          </p>
        </div>
        {/* UI gate is convenience only — the API enforces storage.manage server-side. */}
        {hasPermission(PERMISSIONS.STORAGE_MANAGE) ? <StorageManager /> : <ForbiddenState />}
      </div>
    </AppShell>
  );
}

function StorageManager() {
  const [selectedBucket, setSelectedBucket] = useState<string | null>(null);

  const configQuery = useQuery({ queryKey: ['storage-config'], queryFn: getStorageConfig });
  const bucketsQuery = useQuery({ queryKey: ['storage-buckets'], queryFn: listBuckets });

  const forbidden = (bucketsQuery.error as AxiosError | null)?.response?.status === 403;

  if (bucketsQuery.isLoading) return <LoadingState label="Loading storage…" />;
  if (forbidden) return <ForbiddenState />;
  if (bucketsQuery.isError) {
    return (
      <ErrorState
        description="We couldn't load the buckets."
        onRetry={() => void bucketsQuery.refetch()}
      />
    );
  }

  const buckets = bucketsQuery.data ?? [];
  const activeBucket = selectedBucket ?? configQuery.data?.bucket ?? buckets[0]?.name ?? null;

  return (
    <div className="space-y-6">
      {configQuery.data && <ConfigCard config={configQuery.data} />}

      <div className="grid gap-6 lg:grid-cols-2">
        <BucketsCard
          buckets={buckets}
          activeBucket={activeBucket}
          onSelect={setSelectedBucket}
        />
        {activeBucket ? (
          <PrefixesCard bucket={activeBucket} />
        ) : (
          <div className="card p-5">
            <EmptyState title="No bucket selected" description="Create or select a bucket." />
          </div>
        )}
      </div>
    </div>
  );
}

function ConfigCard({
  config,
}: {
  config: { bucket: string; prefixes: { documents: string; renditions: string }; endpoint: string | null; region: string };
}) {
  const rows: [string, string][] = [
    ['Default bucket', config.bucket],
    ['Documents prefix', config.prefixes.documents],
    ['Renditions prefix', config.prefixes.renditions],
    ['Endpoint', config.endpoint ?? 'AWS default'],
    ['Region', config.region],
  ];
  return (
    <div className="card p-5">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-muted">
        Configuration
      </h2>
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4 sm:block">
            <dt className="text-ink-muted">{label}</dt>
            <dd className="font-medium text-ink sm:mt-0.5">
              <code className="text-xs">{value}</code>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function BucketsCard({
  buckets,
  activeBucket,
  onSelect,
}: {
  buckets: StorageBucket[];
  activeBucket: string | null;
  onSelect: (name: string) => void;
}) {
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div className="card p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">Buckets</h2>
        <button className="btn-secondary !py-1 text-xs" onClick={() => setShowCreate((v) => !v)}>
          {showCreate ? 'Close' : 'New bucket'}
        </button>
      </div>

      {showCreate && <CreateBucketForm onDone={() => setShowCreate(false)} />}

      <ul className="mt-2 divide-y divide-slate-100">
        {buckets.map((b) => {
          const active = b.name === activeBucket;
          return (
            <li key={b.name}>
              <button
                className={`flex w-full items-center justify-between gap-2 py-2.5 text-left text-sm ${
                  active ? 'font-semibold text-brand-700' : 'text-ink-soft hover:text-ink'
                }`}
                onClick={() => onSelect(b.name)}
                aria-current={active}
              >
                <span className="truncate">
                  {b.name}
                  {b.isDefault && (
                    <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-ink-muted">
                      Default
                    </span>
                  )}
                </span>
                <span aria-hidden className="text-ink-muted">
                  {active ? '›' : ''}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function CreateBucketForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => createBucket(name.trim()),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['storage-buckets'] });
      setName('');
      setConfirm(false);
      onDone();
    },
    onError: (err) => {
      setConfirm(false);
      const res = (err as AxiosError<{ message?: string }>).response;
      setError(
        res?.status === 409
          ? 'A bucket with that name already exists.'
          : res?.data?.message ?? 'Could not create the bucket.',
      );
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim().length < 3) {
      setError('Bucket names must be at least 3 characters.');
      return;
    }
    setError(null);
    setConfirm(true);
  };

  return (
    <form className="mb-3 rounded-lg border border-slate-200 bg-slate-50/60 p-3" onSubmit={onSubmit} aria-label="Create bucket">
      <label htmlFor="sb-name" className="label">
        Bucket name
      </label>
      <div className="flex gap-2">
        <input
          id="sb-name"
          className="input"
          placeholder="e.g. policymanager-archive"
          value={name}
          onChange={(e) => setName(e.target.value.toLowerCase())}
          autoComplete="off"
        />
        <button type="submit" className="btn-primary whitespace-nowrap" disabled={mutation.isPending}>
          {mutation.isPending ? 'Creating…' : 'Create'}
        </button>
      </div>
      <p className="mt-1 text-xs text-ink-muted">
        Lowercase letters, numbers, and hyphens. 3–63 characters. Created private + versioned.
      </p>
      {error && (
        <p className="mt-1 text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={confirm}
        title="Create bucket?"
        body={
          <>
            Create a new private, versioned bucket named{' '}
            <span className="font-medium text-ink">{name.trim()}</span>? Buckets cannot be deleted
            from this screen.
          </>
        }
        confirmLabel="Create bucket"
        busy={mutation.isPending}
        onConfirm={() => mutation.mutate()}
        onCancel={() => setConfirm(false)}
      />
    </form>
  );
}

function PrefixesCard({ bucket }: { bucket: string }) {
  const query = useQuery({
    queryKey: ['storage-prefixes', bucket],
    queryFn: () => listPrefixes(bucket),
  });

  return (
    <div className="card p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="truncate text-sm font-semibold uppercase tracking-wide text-ink-muted">
          Folders in <code className="text-xs normal-case">{bucket}</code>
        </h2>
      </div>

      <CreateFolderForm bucket={bucket} />

      {query.isLoading ? (
        <LoadingState label="Loading folders…" />
      ) : query.isError ? (
        <ErrorState description="We couldn't load folders." onRetry={() => void query.refetch()} />
      ) : (query.data ?? []).length === 0 ? (
        <p className="mt-3 text-sm text-ink-muted">No folders yet. Create one above.</p>
      ) : (
        <ul className="mt-3 space-y-1 text-sm">
          {(query.data ?? []).map((p) => (
            <li key={p.prefix} className="flex items-center gap-2 text-ink-soft">
              <span aria-hidden className="text-ink-muted">
                📁
              </span>
              <code className="text-xs">{p.prefix}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CreateFolderForm({ bucket }: { bucket: string }) {
  const queryClient = useQueryClient();
  const [prefix, setPrefix] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => createPrefix(bucket, prefix.trim()),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['storage-prefixes', bucket] });
      setPrefix('');
      setError(null);
    },
    onError: (err) => {
      const res = (err as AxiosError<{ message?: string }>).response;
      setError(res?.data?.message ?? 'Could not create the folder.');
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (prefix.trim().length === 0) {
      setError('Enter a folder name.');
      return;
    }
    mutation.mutate();
  };

  return (
    <form className="flex flex-wrap items-end gap-2" onSubmit={onSubmit} aria-label="Create folder">
      <div className="min-w-[12rem] flex-1">
        <label htmlFor="sf-prefix" className="label">
          New folder
        </label>
        <input
          id="sf-prefix"
          className="input"
          placeholder="e.g. policies/intake"
          value={prefix}
          onChange={(e) => setPrefix(e.target.value)}
          autoComplete="off"
        />
      </div>
      <button type="submit" className="btn-secondary" disabled={mutation.isPending}>
        {mutation.isPending ? 'Adding…' : 'Add folder'}
      </button>
      {error && (
        <p className="w-full text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
