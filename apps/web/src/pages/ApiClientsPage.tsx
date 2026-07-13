import { FormEvent, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import {
  API_SCOPES,
  API_SCOPE_LABELS,
  PERMISSIONS,
  type ApiClientItem,
  type ApiClientSecret,
  type ApiScope,
} from '@policymanager/shared';
import {
  createApiClient,
  listApiClients,
  revokeApiClient,
  rotateApiClientSecret,
} from '../api/apiClients';
import { flattenCategories, listCategoryTree } from '../api/categories';
import { useAuth } from '../auth/AuthContext';
import { formatDateTime } from '../lib/format';
import { AppShell } from '../ui/AppShell';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Modal } from '../ui/Modal';
import { EmptyState, ErrorState, ForbiddenState, LoadingState } from '../ui/states';

/**
 * API Clients admin (Phase 7, `/admin/api-clients`). Gated by `api.manage` — the
 * server enforces it too; the UI gate is convenience only (AGENTS.md §8). Secrets
 * are shown exactly once at create/rotate and can never be retrieved again.
 */
export function ApiClientsPage() {
  const { hasPermission } = useAuth();
  return (
    <AppShell>
      <div className="mx-auto max-w-6xl">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-ink">API Clients</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Machine keys for the read-only public API (<code className="text-ink-soft">/api/v1</code>)
            used by EMR and AI integrations. Secrets are shown once at creation and stored only as a
            hash.
          </p>
        </div>
        {hasPermission(PERMISSIONS.API_MANAGE) ? <ApiClientsManager /> : <ForbiddenState />}
      </div>
    </AppShell>
  );
}

function ApiClientsManager() {
  const clientsQuery = useQuery({ queryKey: ['api-clients'], queryFn: listApiClients });
  const categoriesQuery = useQuery({ queryKey: ['categories'], queryFn: listCategoryTree });

  const [createOpen, setCreateOpen] = useState(false);
  const [secret, setSecret] = useState<ApiClientSecret | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiClientItem | null>(null);

  const categoryNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of flattenCategories(categoriesQuery.data ?? [])) map.set(c.id, c.name);
    return map;
  }, [categoriesQuery.data]);

  const forbidden = (clientsQuery.error as AxiosError | null)?.response?.status === 403;

  if (clientsQuery.isLoading) return <LoadingState label="Loading API clients…" />;
  if (forbidden) return <ForbiddenState />;
  if (clientsQuery.isError) {
    return (
      <ErrorState
        description="We couldn't load the API clients."
        onRetry={() => void clientsQuery.refetch()}
      />
    );
  }

  const clients = clientsQuery.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-muted">
          {clients.length} {clients.length === 1 ? 'client' : 'clients'}
        </p>
        <button className="btn-primary" onClick={() => setCreateOpen(true)}>
          New API client
        </button>
      </div>

      {clients.length === 0 ? (
        <EmptyState
          title="No API clients yet"
          description="Create a key to let an EMR or AI service read published documents."
          action={
            <button className="btn-primary" onClick={() => setCreateOpen(true)}>
              New API client
            </button>
          }
        />
      ) : (
        <ClientsTable
          clients={clients}
          categoryNameById={categoryNameById}
          onRevoke={(c) => setRevokeTarget(c)}
          onRotated={(result) => setSecret(result)}
        />
      )}

      {createOpen && (
        <CreateClientModal
          onClose={() => setCreateOpen(false)}
          onCreated={(result) => {
            setCreateOpen(false);
            setSecret(result);
          }}
        />
      )}

      {secret && <SecretRevealModal secret={secret} onClose={() => setSecret(null)} />}

      <RevokeConfirm target={revokeTarget} onDone={() => setRevokeTarget(null)} />
    </div>
  );
}

function ClientsTable({
  clients,
  categoryNameById,
  onRevoke,
  onRotated,
}: {
  clients: ApiClientItem[];
  categoryNameById: Map<string, string>;
  onRevoke: (c: ApiClientItem) => void;
  onRotated: (result: ApiClientSecret) => void;
}) {
  return (
    <div className="card overflow-x-auto p-0">
      <table className="w-full min-w-[860px] text-left text-sm">
        <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-ink-muted">
          <tr>
            <th scope="col" className="px-4 py-3 font-medium">Name</th>
            <th scope="col" className="px-4 py-3 font-medium">Client ID</th>
            <th scope="col" className="px-4 py-3 font-medium">Scopes</th>
            <th scope="col" className="px-4 py-3 font-medium">Categories</th>
            <th scope="col" className="px-4 py-3 font-medium">Status</th>
            <th scope="col" className="px-4 py-3 font-medium">Last used</th>
            <th scope="col" className="px-4 py-3 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {clients.map((c) => (
            <ClientRow
              key={c.id}
              client={c}
              categoryNameById={categoryNameById}
              onRevoke={onRevoke}
              onRotated={onRotated}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ClientRow({
  client,
  categoryNameById,
  onRevoke,
  onRotated,
}: {
  client: ApiClientItem;
  categoryNameById: Map<string, string>;
  onRevoke: (c: ApiClientItem) => void;
  onRotated: (result: ApiClientSecret) => void;
}) {
  const queryClient = useQueryClient();
  const rotate = useMutation({
    mutationFn: () => rotateApiClientSecret(client.id),
    onSuccess: (result) => {
      onRotated(result);
      void queryClient.invalidateQueries({ queryKey: ['api-clients'] });
    },
  });

  const revoked = !!client.revokedAt;
  const status = revoked ? 'Revoked' : client.enabled ? 'Active' : 'Disabled';
  const statusClasses = revoked
    ? 'bg-red-100 text-red-700'
    : client.enabled
      ? 'bg-green-100 text-green-700'
      : 'bg-slate-100 text-ink-soft';

  const categories =
    client.allowedCategoryIds.length === 0
      ? 'All'
      : client.allowedCategoryIds
          .map((id) => categoryNameById.get(id) ?? id)
          .join(', ');

  return (
    <tr>
      <td className="px-4 py-3 align-top">
        <div className="font-medium text-ink">{client.name}</div>
        <div className="text-xs text-ink-muted">
          Created {formatDateTime(client.createdAt)}
          {client.createdByName ? ` by ${client.createdByName}` : ''}
        </div>
      </td>
      <td className="px-4 py-3 align-top">
        <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-ink-soft">
          {client.clientId}
        </code>
      </td>
      <td className="px-4 py-3 align-top">
        <div className="flex flex-wrap gap-1">
          {client.scopes.map((s) => (
            <span
              key={s}
              className="inline-flex rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700"
            >
              {s}
            </span>
          ))}
        </div>
      </td>
      <td className="px-4 py-3 align-top text-ink-soft">{categories}</td>
      <td className="px-4 py-3 align-top">
        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusClasses}`}>
          {status}
        </span>
      </td>
      <td className="px-4 py-3 align-top text-ink-soft">
        {client.lastUsedAt ? formatDateTime(client.lastUsedAt) : 'Never'}
      </td>
      <td className="px-4 py-3 align-top">
        <div className="flex justify-end gap-3">
          {!revoked && (
            <>
              <button
                className="text-xs font-medium text-brand-600 hover:underline disabled:opacity-50"
                onClick={() => rotate.mutate()}
                disabled={rotate.isPending}
              >
                {rotate.isPending ? 'Rotating…' : 'Rotate secret'}
              </button>
              <button
                className="text-xs font-medium text-red-600 hover:underline"
                onClick={() => onRevoke(client)}
              >
                Revoke
              </button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

function CreateClientModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (result: ApiClientSecret) => void;
}) {
  const categoriesQuery = useQuery({ queryKey: ['categories'], queryFn: listCategoryTree });
  const flatCategories = useMemo(
    () => flattenCategories(categoriesQuery.data ?? []),
    [categoriesQuery.data],
  );

  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiScope[]>(['documents:read']);
  const [categoryIds, setCategoryIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      createApiClient({ name: name.trim(), scopes, allowedCategoryIds: categoryIds }),
    onSuccess: onCreated,
    onError: () => setError('Could not create the client. Check the values and try again.'),
  });

  const toggleScope = (scope: ApiScope) => {
    setScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    );
  };
  const toggleCategory = (id: string) => {
    setCategoryIds((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('A name is required.');
      return;
    }
    if (scopes.length === 0) {
      setError('Select at least one scope.');
      return;
    }
    setError(null);
    mutation.mutate();
  };

  return (
    <Modal open onClose={onClose} titleId="create-api-client-title">
      <form onSubmit={onSubmit} aria-label="Create API client">
        <h2 id="create-api-client-title" className="text-base font-semibold text-ink">
          New API client
        </h2>
        <p className="mt-1 text-sm text-ink-muted">
          The secret will be shown once after creation.
        </p>

        {error && (
          <div
            className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
            role="alert"
          >
            {error}
          </div>
        )}

        <div className="mt-4 space-y-4">
          <div>
            <label htmlFor="ac-name" className="label">
              Name
            </label>
            <input
              id="ac-name"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="EMR Integration"
              autoFocus
            />
          </div>

          <fieldset>
            <legend className="label">Scopes</legend>
            <div className="space-y-2">
              {API_SCOPES.map((scope) => (
                <label key={scope} className="flex items-start gap-2 text-sm text-ink-soft">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={scopes.includes(scope)}
                    onChange={() => toggleScope(scope)}
                  />
                  <span>
                    <span className="font-medium text-ink">{scope}</span>
                    <span className="ml-1 text-ink-muted">— {API_SCOPE_LABELS[scope]}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className="label">
              Allowed categories{' '}
              <span className="font-normal text-ink-muted">(none selected = all)</span>
            </legend>
            {flatCategories.length === 0 ? (
              <p className="text-sm text-ink-muted">No categories defined.</p>
            ) : (
              <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
                {flatCategories.map((cat) => (
                  <label
                    key={cat.id}
                    className="flex items-center gap-2 text-sm text-ink-soft"
                    style={{ paddingLeft: `${cat.depth * 12}px` }}
                  >
                    <input
                      type="checkbox"
                      checked={categoryIds.includes(cat.id)}
                      onChange={() => toggleCategory(cat.id)}
                    />
                    {cat.name}
                  </label>
                ))}
              </div>
            )}
          </fieldset>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={mutation.isPending}>
            {mutation.isPending ? 'Creating…' : 'Create client'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function SecretRevealModal({
  secret,
  onClose,
}: {
  secret: ApiClientSecret;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(secret.credential);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Modal open onClose={onClose} titleId="api-secret-title">
      <h2 id="api-secret-title" className="text-base font-semibold text-ink">
        Save this secret now
      </h2>
      <div
        className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
        role="alert"
      >
        This is the only time the secret will be shown. Store it securely — it cannot be retrieved
        later. If you lose it, rotate the secret to get a new one.
      </div>

      <div className="mt-4">
        <div className="label">Credential (clientId.secret)</div>
        <div className="flex items-center gap-2">
          <code
            className="block w-full overflow-x-auto rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-ink"
            data-testid="api-credential"
          >
            {secret.credential}
          </code>
          <button type="button" className="btn-secondary shrink-0" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <p className="mt-2 text-xs text-ink-muted">
          Send it as <code>Authorization: Bearer {'<credential>'}</code> or the{' '}
          <code>X-Api-Key</code> header.
        </p>
      </div>

      <div className="mt-6 flex justify-end">
        <button type="button" className="btn-primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}

function RevokeConfirm({
  target,
  onDone,
}: {
  target: ApiClientItem | null;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (id: string) => revokeApiClient(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['api-clients'] });
      onDone();
    },
  });

  return (
    <ConfirmDialog
      open={!!target}
      title="Revoke API client?"
      tone="danger"
      confirmLabel="Revoke"
      busy={mutation.isPending}
      body={
        <>
          Revoking <span className="font-medium text-ink">{target?.name}</span> immediately disables
          its key. Any EMR or AI integration using it will stop working. This cannot be undone —
          you'll need to create a new client.
        </>
      }
      onCancel={onDone}
      onConfirm={() => target && mutation.mutate(target.id)}
    />
  );
}
