import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import {
  ACCESS_LEVELS,
  ACL_PERMISSIONS,
  type AccessLevel,
  type AclPermission,
  type AclPrincipalType,
  type DocumentDetail,
} from '@policymanager/shared';
import { AddAclInput, addAcl, listAcl, removeAcl } from '../api/acl';
import { updateDocument } from '../api/documents';
import { listRoles, listUsers } from '../api/users';
import { apiErrorMessage } from '../lib/apiError';
import { useToast } from '../ui/Toast';

/**
 * Access-control panel on the document detail page (document.write users). Shows
 * the access level (editable) plus the per-document ACL grants with add/remove,
 * and explains confidential semantics inline. Server enforces the real boundary.
 */
export function DocumentAclPanel({ doc }: { doc: DocumentDetail }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const aclQuery = useQuery({ queryKey: ['acl', doc.id], queryFn: () => listAcl(doc.id) });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['acl', doc.id] });
    void queryClient.invalidateQueries({ queryKey: ['document', doc.id] });
  };

  const levelMutation = useMutation({
    mutationFn: (accessLevel: AccessLevel) => updateDocument(doc.id, { accessLevel }),
    onSuccess: invalidate,
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not change the access level.')),
  });

  const grants = aclQuery.data ?? [];
  const forbidden = (aclQuery.error as AxiosError | null)?.response?.status === 403;

  return (
    <div className="card space-y-4 p-5">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">Access control</h2>
        <p className="mt-1 text-xs text-ink-muted">
          Who can see and use this document.
        </p>
      </div>

      {/* Access level */}
      <div>
        <label htmlFor="acl-level" className="label">
          Access level
        </label>
        <select
          id="acl-level"
          className="input"
          value={doc.accessLevel}
          disabled={levelMutation.isPending}
          onChange={(e) => levelMutation.mutate(e.target.value as AccessLevel)}
        >
          {ACCESS_LEVELS.map((a) => (
            <option key={a} value={a}>
              {a.charAt(0).toUpperCase() + a.slice(1)}
            </option>
          ))}
        </select>
        <p className="mt-1.5 text-xs text-ink-muted">
          {doc.accessLevel === 'confidential' ? (
            <>
              <span className="font-medium text-ink">Confidential:</span> visible ONLY to the owner,
              Admins, and the roles/users granted below. <span className="font-medium">document.read
              alone is not enough.</span>
            </>
          ) : doc.accessLevel === 'public' ? (
            <>
              <span className="font-medium text-ink">Public:</span> any signed-in user with document
              read access can view it.
            </>
          ) : (
            <>
              <span className="font-medium text-ink">Restricted:</span> any user with document read
              access can view it. Grants below add access for confidential documents.
            </>
          )}
        </p>
      </div>

      {/* Grant list */}
      <div className="border-t border-slate-100 pt-4">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">Grants</h3>
        {aclQuery.isLoading ? (
          <p className="text-sm text-ink-muted">Loading grants…</p>
        ) : forbidden ? (
          <p className="text-sm text-ink-muted">You don&apos;t have access to manage this.</p>
        ) : aclQuery.isError ? (
          <p className="text-sm text-red-600">Couldn&apos;t load grants.</p>
        ) : grants.length === 0 ? (
          <p className="text-sm text-ink-muted">
            No explicit grants. {doc.accessLevel === 'confidential'
              ? 'Only the owner and Admins can access this confidential document.'
              : 'Add grants to extend access when this becomes confidential.'}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {grants.map((g) => (
              <li
                key={g.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-sm"
              >
                <span className="min-w-0 truncate">
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-ink-muted">
                    {g.principalType}
                  </span>{' '}
                  <span className="font-medium text-ink">{g.principalName ?? g.principalId}</span>
                  <span className="text-ink-muted"> · {g.permission}</span>
                </span>
                <RemoveGrantButton documentId={doc.id} aclId={g.id} onDone={invalidate} />
              </li>
            ))}
          </ul>
        )}
      </div>

      {!forbidden && <AddGrantForm documentId={doc.id} onAdded={invalidate} />}
    </div>
  );
}

function RemoveGrantButton({
  documentId,
  aclId,
  onDone,
}: {
  documentId: string;
  aclId: string;
  onDone: () => void;
}) {
  const toast = useToast();
  const mutation = useMutation({
    mutationFn: () => removeAcl(documentId, aclId),
    onSuccess: onDone,
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not remove the grant.')),
  });
  return (
    <button
      className="shrink-0 text-xs font-medium text-red-600 hover:underline"
      onClick={() => mutation.mutate()}
      disabled={mutation.isPending}
      aria-label="Remove grant"
    >
      {mutation.isPending ? '…' : 'Remove'}
    </button>
  );
}

function AddGrantForm({
  documentId,
  onAdded,
}: {
  documentId: string;
  onAdded: () => void;
}) {
  const [principalType, setPrincipalType] = useState<AclPrincipalType>('role');
  const [principalId, setPrincipalId] = useState('');
  const [permission, setPermission] = useState<AclPermission>('view');
  const [error, setError] = useState<string | null>(null);

  // Best-effort directories for the pickers. When the caller lacks user.manage
  // these 403 and we fall back to a free-text id input.
  const rolesQuery = useQuery({ queryKey: ['roles'], queryFn: listRoles, retry: false });
  const usersQuery = useQuery({ queryKey: ['users'], queryFn: listUsers, retry: false });

  const mutation = useMutation({
    mutationFn: (input: AddAclInput) => addAcl(documentId, input),
    onSuccess: () => {
      setPrincipalId('');
      setError(null);
      onAdded();
    },
    onError: (err) => {
      const status = (err as AxiosError).response?.status;
      setError(
        status === 400
          ? 'That role or user could not be found.'
          : status === 403
            ? 'You are not allowed to change access for this document.'
            : 'Could not add the grant. Please try again.',
      );
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!principalId.trim()) {
      setError('Choose a role or user.');
      return;
    }
    mutation.mutate({ principalType, principalId: principalId.trim(), permission });
  };

  const roleOptions = rolesQuery.data ?? [];
  const userOptions = usersQuery.data ?? [];
  const showRolePicker = principalType === 'role' && roleOptions.length > 0;
  const showUserPicker = principalType === 'user' && userOptions.length > 0;

  return (
    <form className="space-y-2 border-t border-slate-100 pt-4" onSubmit={onSubmit} aria-label="Add grant">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Add grant</h3>
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700" role="alert">
          {error}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <select
          aria-label="Principal type"
          className="input !w-auto flex-none"
          value={principalType}
          onChange={(e) => {
            setPrincipalType(e.target.value as AclPrincipalType);
            setPrincipalId('');
          }}
        >
          <option value="role">Role</option>
          <option value="user">User</option>
        </select>

        {showRolePicker ? (
          <select
            aria-label="Role"
            className="input min-w-[8rem] flex-1"
            value={principalId}
            onChange={(e) => setPrincipalId(e.target.value)}
          >
            <option value="">Select a role…</option>
            {roleOptions.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        ) : showUserPicker ? (
          <select
            aria-label="User"
            className="input min-w-[8rem] flex-1"
            value={principalId}
            onChange={(e) => setPrincipalId(e.target.value)}
          >
            <option value="">Select a user…</option>
            {userOptions.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.email})
              </option>
            ))}
          </select>
        ) : (
          <input
            aria-label={principalType === 'role' ? 'Role id' : 'User id'}
            className="input min-w-[8rem] flex-1"
            placeholder={principalType === 'role' ? 'Role id' : 'User id'}
            value={principalId}
            onChange={(e) => setPrincipalId(e.target.value)}
          />
        )}

        <select
          aria-label="Permission"
          className="input !w-auto flex-none"
          value={permission}
          onChange={(e) => setPermission(e.target.value as AclPermission)}
        >
          {ACL_PERMISSIONS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>
      <button type="submit" className="btn-primary !py-1.5 text-sm" disabled={mutation.isPending}>
        {mutation.isPending ? 'Adding…' : 'Add grant'}
      </button>
    </form>
  );
}
