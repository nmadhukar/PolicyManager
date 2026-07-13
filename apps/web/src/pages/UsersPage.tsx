import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { PERMISSIONS } from '@policymanager/shared';
import {
  assignRoles,
  createUser,
  CreateUserInput,
  listRoles,
  listUsers,
  RoleView,
  setUserStatus,
  UserView,
} from '../api/users';
import { useAuth } from '../auth/AuthContext';
import { AppShell } from '../ui/AppShell';
import { EmptyState, ErrorState, ForbiddenState, LoadingState } from '../ui/states';

export function UsersPage() {
  const { hasPermission } = useAuth();

  return (
    <AppShell>
      <div className="mx-auto max-w-5xl">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-ink">Users</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Create accounts, assign roles, and control access to PolicyManager.
          </p>
        </div>
        {/* UI gate is convenience only — the API enforces user.manage server-side. */}
        {hasPermission(PERMISSIONS.USER_MANAGE) ? <UsersManager /> : <ForbiddenState />}
      </div>
    </AppShell>
  );
}

function UsersManager() {
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);

  const usersQuery = useQuery({ queryKey: ['users'], queryFn: listUsers });
  const rolesQuery = useQuery({ queryKey: ['roles'], queryFn: listRoles });

  const forbidden =
    (usersQuery.error as AxiosError | null)?.response?.status === 403;

  if (usersQuery.isLoading) return <LoadingState label="Loading users…" />;
  if (forbidden) return <ForbiddenState />;
  if (usersQuery.isError) {
    return (
      <ErrorState
        description="We couldn't load the user list."
        onRetry={() => void usersQuery.refetch()}
      />
    );
  }

  const users = usersQuery.data ?? [];
  const roles = rolesQuery.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button className="btn-primary" onClick={() => setShowCreate((v) => !v)}>
          {showCreate ? 'Close' : 'New user'}
        </button>
      </div>

      {showCreate && (
        <CreateUserPanel
          roles={roles}
          onDone={() => {
            setShowCreate(false);
            void queryClient.invalidateQueries({ queryKey: ['users'] });
          }}
        />
      )}

      {users.length === 0 ? (
        <EmptyState
          title="No users yet"
          description="Create the first account to get started."
          action={
            <button className="btn-primary" onClick={() => setShowCreate(true)}>
              New user
            </button>
          }
        />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-ink-muted">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">User</th>
                <th scope="col" className="px-4 py-3 font-medium">Roles</th>
                <th scope="col" className="px-4 py-3 font-medium">Status</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {users.map((user) => (
                <UserRow key={user.id} user={user} roles={roles} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CreateUserPanel({ roles, onDone }: { roles: RoleView[]; onDone: () => void }) {
  const [form, setForm] = useState<CreateUserInput>({ email: '', name: '', title: '', roles: [] });
  const [error, setError] = useState<string | null>(null);
  const [tempPassword, setTempPassword] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: createUser,
    onSuccess: (data) => {
      setTempPassword(data.temporaryPassword);
      setError(null);
    },
    onError: (err) => {
      const status = (err as AxiosError).response?.status;
      setError(
        status === 409
          ? 'A user with that email already exists.'
          : status === 400
            ? 'Please check the form and try again.'
            : 'Unable to create the user right now.',
      );
    },
  });

  const toggleRole = (name: string) =>
    setForm((f) => ({
      ...f,
      roles: f.roles?.includes(name)
        ? f.roles.filter((r) => r !== name)
        : [...(f.roles ?? []), name],
    }));

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    mutation.mutate({
      email: form.email.trim(),
      name: form.name.trim(),
      title: form.title?.trim() || undefined,
      roles: form.roles,
    });
  };

  if (tempPassword) {
    return (
      <div className="card space-y-3 border-brand-200 bg-brand-50 p-6">
        <h3 className="text-sm font-semibold text-ink">User created</h3>
        <p className="text-sm text-ink-soft">
          Share this temporary password securely. It will not be shown again.
        </p>
        <code className="block rounded-lg border border-brand-200 bg-white px-3 py-2 font-mono text-sm text-ink">
          {tempPassword}
        </code>
        <button className="btn-primary" onClick={onDone}>
          Done
        </button>
      </div>
    );
  }

  return (
    <form className="card space-y-4 p-6" onSubmit={onSubmit}>
      <h3 className="text-sm font-semibold text-ink">New user</h3>
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="cu-name" className="label">Full name</label>
          <input
            id="cu-name"
            className="input"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
        </div>
        <div>
          <label htmlFor="cu-email" className="label">Email</label>
          <input
            id="cu-email"
            type="email"
            className="input"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            required
          />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="cu-title" className="label">Title (optional)</label>
          <input
            id="cu-title"
            className="input"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
        </div>
      </div>

      <fieldset>
        <legend className="label">Roles</legend>
        <div className="flex flex-wrap gap-2">
          {roles.map((role) => {
            const checked = form.roles?.includes(role.name) ?? false;
            return (
              <label
                key={role.id}
                className={`cursor-pointer rounded-lg border px-3 py-1.5 text-sm ${
                  checked
                    ? 'border-brand-400 bg-brand-50 text-brand-700'
                    : 'border-slate-300 text-ink-soft hover:bg-slate-50'
                }`}
              >
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={checked}
                  onChange={() => toggleRole(role.name)}
                />
                {role.name}
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="flex justify-end gap-2">
        <button type="submit" className="btn-primary" disabled={mutation.isPending}>
          {mutation.isPending ? 'Creating…' : 'Create user'}
        </button>
      </div>
    </form>
  );
}

function UserRow({ user, roles }: { user: UserView; roles: RoleView[] }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<string[]>(user.roles);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['users'] });

  const roleMutation = useMutation({
    mutationFn: (next: string[]) => assignRoles(user.id, next),
    onSuccess: () => {
      setEditing(false);
      void invalidate();
    },
  });

  const statusMutation = useMutation({
    mutationFn: (enable: boolean) => setUserStatus(user.id, enable),
    onSuccess: () => void invalidate(),
  });

  const disabled = user.status === 'disabled';

  return (
    <tr className={disabled ? 'bg-slate-50/60' : undefined}>
      <td className="px-4 py-3 align-top">
        <div className="font-medium text-ink">{user.name}</div>
        <div className="text-xs text-ink-muted">{user.email}</div>
        {user.title && <div className="text-xs text-ink-muted">{user.title}</div>}
      </td>
      <td className="px-4 py-3 align-top">
        {editing ? (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1.5">
              {roles.map((role) => {
                const checked = selected.includes(role.name);
                return (
                  <label
                    key={role.id}
                    className={`cursor-pointer rounded-md border px-2 py-1 text-xs ${
                      checked
                        ? 'border-brand-400 bg-brand-50 text-brand-700'
                        : 'border-slate-300 text-ink-soft hover:bg-slate-50'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={checked}
                      onChange={() =>
                        setSelected((s) =>
                          s.includes(role.name)
                            ? s.filter((r) => r !== role.name)
                            : [...s, role.name],
                        )
                      }
                    />
                    {role.name}
                  </label>
                );
              })}
            </div>
            <div className="flex gap-2">
              <button
                className="btn-primary !px-3 !py-1 text-xs"
                onClick={() => roleMutation.mutate(selected)}
                disabled={roleMutation.isPending}
              >
                {roleMutation.isPending ? 'Saving…' : 'Save'}
              </button>
              <button
                className="btn-secondary !px-3 !py-1 text-xs"
                onClick={() => {
                  setSelected(user.roles);
                  setEditing(false);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            {user.roles.length > 0 ? (
              user.roles.map((r) => (
                <span
                  key={r}
                  className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-ink-soft"
                >
                  {r}
                </span>
              ))
            ) : (
              <span className="text-xs text-ink-muted">No roles</span>
            )}
            <button
              className="text-xs font-medium text-brand-600 hover:underline"
              onClick={() => setEditing(true)}
            >
              Edit
            </button>
          </div>
        )}
      </td>
      <td className="px-4 py-3 align-top">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${
            disabled ? 'bg-slate-200 text-ink-soft' : 'bg-green-100 text-green-700'
          }`}
        >
          <span
            aria-hidden
            className={`h-1.5 w-1.5 rounded-full ${disabled ? 'bg-slate-500' : 'bg-green-500'}`}
          />
          {disabled ? 'Disabled' : 'Active'}
        </span>
      </td>
      <td className="px-4 py-3 text-right align-top">
        <button
          className="btn-secondary !px-3 !py-1 text-xs"
          onClick={() => statusMutation.mutate(disabled)}
          disabled={statusMutation.isPending}
        >
          {statusMutation.isPending ? '…' : disabled ? 'Enable' : 'Disable'}
        </button>
      </td>
    </tr>
  );
}
