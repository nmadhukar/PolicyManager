import { FormEvent, Suspense, lazy, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import {
  ACK_STATUS_LABELS,
  type AckStatus,
  type MyAcknowledgmentItem,
} from '@policymanager/shared';
import { acknowledge, listMyAcknowledgments } from '../api/acknowledgments';
import { useAuth } from '../auth/AuthContext';
import { formatDate } from '../lib/format';
import { AppShell } from '../ui/AppShell';
import { Modal } from '../ui/Modal';
import { EmptyState, ErrorState, LoadingState } from '../ui/states';

// The viewer pulls in pdf.js; code-split it so the list renders without that cost.
const DocumentViewer = lazy(() => import('../ui/DocumentViewer'));

/** Badge classes per acknowledgment status. */
function ackBadge(status: AckStatus): string {
  switch (status) {
    case 'completed':
      return 'bg-green-100 text-green-700';
    case 'overdue':
      return 'bg-red-100 text-red-700';
    case 'cancelled':
      return 'bg-slate-200 text-ink-soft';
    default:
      return 'bg-amber-100 text-amber-700';
  }
}

export function AcknowledgmentsPage() {
  return (
    <AppShell>
      <div className="mx-auto max-w-3xl">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-ink">My Acknowledgments</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Policies assigned to you to read and acknowledge. Open each one, then confirm you have
            read and understand it.
          </p>
        </div>
        <AcknowledgmentsList />
      </div>
    </AppShell>
  );
}

function AcknowledgmentsList() {
  const query = useQuery({ queryKey: ['my-acknowledgments'], queryFn: listMyAcknowledgments });

  if (query.isLoading) return <LoadingState label="Loading your acknowledgments…" />;
  if (query.isError) {
    return (
      <ErrorState
        description="We couldn't load your acknowledgments."
        onRetry={() => void query.refetch()}
      />
    );
  }

  const items = query.data ?? [];
  const open = items.filter((a) => a.status === 'pending' || a.status === 'overdue');
  const completed = items.filter((a) => a.status === 'completed');

  if (items.length === 0) {
    return (
      <EmptyState
        title="Nothing to acknowledge"
        description="When a policy is assigned to you to read, it will appear here."
      />
    );
  }

  return (
    <div className="space-y-6">
      <section aria-label="To acknowledge" className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
          To acknowledge ({open.length})
        </h2>
        {open.length === 0 ? (
          <p className="card p-5 text-sm text-ink-muted">You&apos;re all caught up. 🎉</p>
        ) : (
          open.map((item) => <OpenCard key={item.id} item={item} />)
        )}
      </section>

      {completed.length > 0 && (
        <section aria-label="Completed" className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
            Completed ({completed.length})
          </h2>
          {completed.map((item) => (
            <div
              key={item.id}
              className="card flex items-center justify-between gap-3 p-4 text-sm"
            >
              <div className="min-w-0">
                <Link to={`/library/${item.documentId}`} className="font-medium text-ink hover:underline">
                  {item.documentTitle ?? 'Untitled document'}
                </Link>
                <div className="mt-0.5 text-xs text-ink-muted">
                  Acknowledged {formatDate(item.completedAt)}
                  {item.versionNumber != null ? ` · v${item.versionNumber}` : ''}
                </div>
              </div>
              <span className="inline-flex shrink-0 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
                {ACK_STATUS_LABELS.completed}
              </span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

/** A pending/overdue assignment: view the document, then attest. */
function OpenCard({ item }: { item: MyAcknowledgmentItem }) {
  const [viewing, setViewing] = useState(false);
  const [viewed, setViewed] = useState(false);
  const [attesting, setAttesting] = useState(false);

  return (
    <div className="card space-y-3 p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <Link to={`/library/${item.documentId}`} className="font-medium text-ink hover:underline">
            {item.documentTitle ?? 'Untitled document'}
          </Link>
          {item.documentNumber && (
            <span className="ml-2 text-xs text-ink-muted">{item.documentNumber}</span>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
            <span className={`inline-flex rounded-full px-2 py-0.5 font-medium ${ackBadge(item.status)}`}>
              {ACK_STATUS_LABELS[item.status]}
            </span>
            {item.dueDate && <span>Due {formatDate(item.dueDate)}</span>}
            {item.versionNumber != null && <span>· v{item.versionNumber}</span>}
            {item.assignedByName && <span>· Assigned by {item.assignedByName}</span>}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          className="btn-secondary !py-1.5 text-sm"
          onClick={() => {
            setViewing(true);
            setViewed(true);
          }}
        >
          {viewed ? 'Re-open document' : 'Open & review'}
        </button>
        <button
          className="btn-primary !py-1.5 text-sm"
          onClick={() => setAttesting(true)}
          disabled={!viewed}
          title={viewed ? undefined : 'Open and read the document first'}
        >
          I have read and understand
        </button>
        {!viewed && (
          <span className="text-xs text-ink-muted">Open the document to enable acknowledgment.</span>
        )}
      </div>

      {viewing && (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/60 text-sm text-white" role="status">
              Loading…
            </div>
          }
        >
          <DocumentViewer
            documentId={item.documentId}
            version={{ id: item.versionId, fileName: item.documentTitle ?? 'Document' }}
            onClose={() => setViewing(false)}
          />
        </Suspense>
      )}

      {attesting && (
        <AttestModal item={item} viewed={viewed} onClose={() => setAttesting(false)} />
      )}
    </div>
  );
}

/** Captures the typed "I have read and understand" signature and submits it. */
function AttestModal({
  item,
  viewed,
  onClose,
}: {
  item: MyAcknowledgmentItem;
  viewed: boolean;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [signatureName, setSignatureName] = useState(user?.name ?? '');
  const [signatureRole, setSignatureRole] = useState(user?.roles?.[0] ?? '');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      acknowledge(item.id, {
        hasViewed: viewed,
        signatureName: signatureName.trim() || undefined,
        signatureRole: signatureRole.trim() || undefined,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['my-acknowledgments'] });
      onClose();
    },
    onError: (err) => {
      const status = (err as AxiosError).response?.status;
      setError(
        status === 400
          ? 'Please open and read the document before acknowledging.'
          : status === 403
            ? 'You can only acknowledge your own assignments.'
            : 'Could not record your acknowledgment. Please try again.',
      );
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!signatureName.trim()) {
      setError('Enter your name to sign.');
      return;
    }
    setError(null);
    mutation.mutate();
  };

  return (
    <Modal open onClose={onClose} titleId="ack-title">
      <form onSubmit={onSubmit} aria-label="Acknowledge document">
        <h2 id="ack-title" className="text-base font-semibold text-ink">
          I have read and understand
        </h2>
        <p className="mt-1 text-sm text-ink-soft">{item.documentTitle}</p>
        <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-ink-muted">
          Your name, role, timestamp, and IP are recorded as an immutable acknowledgment (compliance
          evidence).
        </p>

        {error && (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            {error}
          </div>
        )}

        <div className="mt-4">
          <label htmlFor="ack-name" className="label">
            Signature (your name) <span className="text-red-600">*</span>
          </label>
          <input
            id="ack-name"
            className="input"
            value={signatureName}
            onChange={(e) => setSignatureName(e.target.value)}
            required
          />
        </div>
        <div className="mt-3">
          <label htmlFor="ack-role" className="label">
            Role / title <span className="font-normal text-ink-muted">(optional)</span>
          </label>
          <input
            id="ack-role"
            className="input"
            value={signatureRole}
            onChange={(e) => setSignatureRole(e.target.value)}
          />
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={mutation.isPending}>
            {mutation.isPending ? 'Signing…' : 'Acknowledge'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
