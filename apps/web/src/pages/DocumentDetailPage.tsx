import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { PERMISSIONS, type DocumentDetail } from '@policymanager/shared';
import {
  archiveDocument,
  getDocument,
  softDeleteDocument,
  unarchiveDocument,
  updateDocument,
} from '../api/documents';
import { DocumentAclPanel } from './DocumentAclPanel';
import { DocumentReviewersPanel } from './DocumentReviewersPanel';
import { DocumentSignoffPanel } from './DocumentSignoffPanel';
import { DocumentAcknowledgmentPanel } from './DocumentAcknowledgmentPanel';
import { EditMetadata, MetadataBody } from './document-detail/EditMetadata';
import { VersionsCard } from './document-detail/VersionsCard';
import { useAuth } from '../auth/AuthContext';
import { statusBadgeClasses, statusLabel } from '../lib/format';
import { AppShell } from '../ui/AppShell';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { EmptyState, ErrorState, ForbiddenState, LoadingState } from '../ui/states';
import { TagInput } from '../ui/TagInput';
import {
  AccessIcon,
  AcknowledgmentIcon,
  CardSection,
  DetailsIcon,
  GovernanceIcon,
  SectionCard,
} from '../ui/SectionCard';
import { useToast } from '../ui/Toast';
import { apiErrorMessage } from '../lib/apiError';

export function DocumentDetailPage() {
  const { hasPermission } = useAuth();
  const { id } = useParams<{ id: string }>();

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-7xl">
        <Link to="/library" className="text-sm font-medium text-brand-600 hover:underline">
          ← Back to library
        </Link>
        <div className="mt-3">
          {hasPermission(PERMISSIONS.DOCUMENT_READ) ? (
            <Detail id={id ?? ''} />
          ) : (
            <ForbiddenState />
          )}
        </div>
      </div>
    </AppShell>
  );
}

function Detail({ id }: { id: string }) {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission(PERMISSIONS.DOCUMENT_WRITE);
  const canManageReviews = hasPermission(PERMISSIONS.REVIEW_MANAGE);

  const query = useQuery({ queryKey: ['document', id], queryFn: () => getDocument(id), enabled: !!id });
  const status = (query.error as AxiosError | null)?.response?.status;

  if (query.isLoading) return <LoadingState label="Loading document…" />;
  if (status === 403) return <ForbiddenState />;
  if (status === 404) {
    return <EmptyState title="Document not found" description="It may have been removed." />;
  }
  if (query.isError || !query.data) {
    return (
      <ErrorState description="We couldn't load this document." onRetry={() => void query.refetch()} />
    );
  }

  const doc = query.data;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="break-words text-2xl font-semibold text-ink">{doc.title}</h1>
          <div className="mt-1 flex items-center gap-2 text-sm text-ink-muted">
            {doc.documentNumber && <span>{doc.documentNumber}</span>}
            <span
              className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${statusBadgeClasses(
                doc.status,
              )}`}
            >
              {statusLabel(doc.status)}
            </span>
          </div>
        </div>
        {canWrite && <DocumentActions doc={doc} />}
      </header>

      {doc.status === 'archived' && (
        <div
          className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-ink-soft"
          role="status"
        >
          <span aria-hidden>🗄️</span>
          <span>
            This document is <span className="font-medium text-ink">archived</span> — it stays
            accessible but is hidden from active lists.
          </span>
        </div>
      )}

      <VersionsCard doc={doc} canWrite={canWrite} />

      {/* Elegant 2x2 governance grid below the full-width version history.
       * items-stretch + each SectionCard's `h-full flex-col` give equal-height
       * rows. Source order is [Details, Governance, Access, Acknowledgment] so
       * row-major 2-col placement puts the two content-heavy cards (Governance,
       * Acknowledgment) in the RIGHT column and pairs one heavy + one light card
       * per row. Permission-gated quadrants simply drop out and the grid reflows
       * (e.g. a canWrite-only user without review.manage gets Q1 + Q2 + Q4 = one
       * orphaned card on row 2) — acceptable per the brief; Sign-off is read for
       * all so Q2 (Governance) is never empty. */}
      <div className="grid grid-cols-1 items-stretch gap-6 lg:grid-cols-2">
        {/* Q1 — Details (metadata body + Tags merged) */}
        <Q1Details doc={doc} canWrite={canWrite} />

        {/* Q2 — Governance (Sign-off always; Review schedule when canManageReviews) */}
        <SectionCard
          icon={<GovernanceIcon />}
          title="Governance"
          subtitle="Sign-off, cover page & review schedule."
        >
          <DocumentSignoffPanel doc={doc} bare />
          {canManageReviews && (
            <CardSection title="Review schedule" divider>
              <DocumentReviewersPanel doc={doc} bare />
            </CardSection>
          )}
        </SectionCard>

        {/* Q4 — Access control (document.write only) */}
        {canWrite && (
          <SectionCard
            icon={<AccessIcon />}
            title="Access control"
            subtitle="Who can see and use this document."
          >
            <DocumentAclPanel doc={doc} bare />
          </SectionCard>
        )}

        {/* Q3 — Staff acknowledgment (review.manage only) */}
        {canManageReviews && (
          <SectionCard
            icon={<AcknowledgmentIcon />}
            title="Staff acknowledgment"
            subtitle="Distribute the current version for staff to read & sign."
          >
            <DocumentAcknowledgmentPanel doc={doc} bare />
          </SectionCard>
        )}
      </div>
    </div>
  );
}

/** Archive/Unarchive + soft-delete actions in the detail header (write users). */
function DocumentActions({ doc }: { doc: DocumentDetail }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['document', doc.id] });
    void queryClient.invalidateQueries({ queryKey: ['documents'] });
  };

  const archive = useMutation({
    mutationFn: () => archiveDocument(doc.id),
    onSuccess: invalidate,
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not archive the document.')),
  });
  const unarchive = useMutation({
    mutationFn: () => unarchiveDocument(doc.id),
    onSuccess: invalidate,
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not unarchive the document.')),
  });
  const del = useMutation({
    mutationFn: () => softDeleteDocument(doc.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      // The document now 404s on this route — return to the library.
      navigate('/library');
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not delete the document.')),
  });

  const busy = archive.isPending || unarchive.isPending || del.isPending;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {doc.status === 'archived' ? (
        <button className="btn-secondary" onClick={() => unarchive.mutate()} disabled={busy}>
          {unarchive.isPending ? 'Unarchiving…' : 'Unarchive'}
        </button>
      ) : (
        <button className="btn-secondary" onClick={() => archive.mutate()} disabled={busy}>
          {archive.isPending ? 'Archiving…' : 'Archive'}
        </button>
      )}
      <button className="btn-danger" onClick={() => setConfirmDelete(true)} disabled={busy}>
        Delete
      </button>
      <ConfirmDialog
        open={confirmDelete}
        title="Move to trash?"
        body={
          <>
            <span className="font-medium text-ink">{doc.title}</span> will be moved to the trash.
            Nothing is permanently deleted — an administrator can restore it from the Trash view.
          </>
        }
        confirmLabel="Delete"
        tone="danger"
        busy={del.isPending}
        onConfirm={() => del.mutate()}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}

/**
 * Q1 quadrant: the Details metadata body + Tags merged into one SectionCard.
 * Owns the edit toggle (swapping the whole quadrant to <EditMetadata>, which
 * keeps its own card/form) and the tags mutation (hoisted from the old
 * QuickTags). For canWrite users Tags is an editable TagInput; for read-only
 * users it falls back to read-only chips so tags stay visible.
 */
function Q1Details({ doc, canWrite }: { doc: DocumentDetail; canWrite: boolean }) {
  const [editing, setEditing] = useState(false);
  const queryClient = useQueryClient();
  const toast = useToast();
  const tagsMutation = useMutation({
    mutationFn: (tags: string[]) => updateDocument(doc.id, { tags }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['document', doc.id] }),
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not update tags.')),
  });

  // Editing swaps the whole quadrant to EditMetadata (its own `card p-5` form).
  if (editing) return <EditMetadata doc={doc} onDone={() => setEditing(false)} />;

  return (
    <SectionCard
      icon={<DetailsIcon />}
      title="Details"
      action={
        canWrite ? (
          <button
            className="text-xs font-medium text-brand-600 hover:underline"
            onClick={() => setEditing(true)}
          >
            Edit
          </button>
        ) : undefined
      }
    >
      <MetadataBody doc={doc} />
      {canWrite ? (
        <CardSection title="Tags" divider>
          <TagInput
            value={doc.tags}
            onChange={(tags) => tagsMutation.mutate(tags)}
            ariaLabel="Edit document tags"
          />
          {tagsMutation.isPending && <p className="mt-2 text-xs text-ink-muted">Saving…</p>}
        </CardSection>
      ) : (
        doc.tags.length > 0 && (
          <CardSection title="Tags" divider>
            <div className="flex flex-wrap gap-1.5">
              {doc.tags.map((t) => (
                <span
                  key={t}
                  className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-ink-soft"
                >
                  {t}
                </span>
              ))}
            </div>
          </CardSection>
        )
      )}
    </SectionCard>
  );
}
