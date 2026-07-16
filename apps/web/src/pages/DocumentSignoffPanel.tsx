import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import {
  ATTESTATION_ACTION_LABELS,
  PERMISSIONS,
  type EvidenceBinderOptions,
  type AttestationItem,
  type DocumentDetail,
} from '@policymanager/shared';
import {
  approveDocument,
  fetchCoverPage,
  fetchExport,
  listAttestations,
} from '../api/signoff';
import { compareVersions } from '../api/documentCompare';
import { exportEvidenceBinder, listEvidenceBinders } from '../api/evidence';
import { useAuth } from '../auth/AuthContext';
import { downloadBlob } from '../lib/download';
import { apiErrorMessage } from '../lib/apiError';
import { formatDateTime } from '../lib/format';
import { Modal } from '../ui/Modal';
import { CardSection } from '../ui/SectionCard';

/** Sanitizes a document identifier into a safe file-name stem. */
function fileStem(doc: DocumentDetail): string {
  return (doc.documentNumber || doc.title || 'document').replace(/[^A-Za-z0-9._-]+/g, '_');
}

/** Badge classes per attestation action. */
function actionBadge(action: AttestationItem['action']): string {
  switch (action) {
    case 'approved':
      return 'bg-green-100 text-green-700';
    case 'reviewed':
      return 'bg-brand-100 text-brand-700';
    default:
      return 'bg-slate-100 text-ink-soft';
  }
}

/**
 * Sign-off panel on the document detail page: the immutable approval chain, an
 * Approve action (document.approve → typed sign-off), and the compliance cover
 * page (preview + cover-prepended export). Read for any document.read user.
 */
export function DocumentSignoffPanel({ doc, bare = false }: { doc: DocumentDetail; bare?: boolean }) {
  const { user, hasPermission } = useAuth();
  const canApprove = hasPermission(PERMISSIONS.DOCUMENT_APPROVE);
  const [signing, setSigning] = useState(false);

  const chainQuery = useQuery({
    queryKey: ['attestations', doc.id],
    queryFn: () => listAttestations(doc.id),
  });
  const chain = chainQuery.data ?? [];
  // A user can only approve a given version once (server-enforced); hide the
  // button once their own approval for the CURRENT version is already in the
  // chain, rather than let them hit the "already approved" error.
  const alreadyApproved = chain.some(
    (a) => a.action === 'approved' && a.userId === user?.id && a.versionId === doc.currentVersion?.id,
  );

  // The Approve control (or the "already approved" note). In bare mode it rides
  // in the CardSection action slot; in full mode it's the card header action.
  const approveAction = (
    <>
      {canApprove && !alreadyApproved && (
        <button className="btn-primary !py-1.5 text-sm" onClick={() => setSigning(true)}>
          Approve
        </button>
      )}
      {canApprove && alreadyApproved && (
        <span className="text-xs text-ink-muted">You already approved this version.</span>
      )}
    </>
  );

  const approvalChain = chainQuery.isLoading ? (
    <p className="text-sm text-ink-muted">Loading sign-offs…</p>
  ) : chainQuery.isError ? (
    <p className="text-sm text-red-600">Couldn&apos;t load sign-offs.</p>
  ) : chain.length === 0 ? (
    <p className="text-sm text-ink-muted">No sign-offs recorded yet.</p>
  ) : (
    <ul className="max-h-56 space-y-2 overflow-y-auto pr-1">
      {chain.map((a) => (
        <li key={a.id} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-ink">{a.signatureName}</span>
            <span
              className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${actionBadge(a.action)}`}
            >
              {ATTESTATION_ACTION_LABELS[a.action]}
            </span>
          </div>
          <div className="mt-0.5 text-xs text-ink-muted">
            {a.signatureRole ? `${a.signatureRole} · ` : ''}
            {formatDateTime(a.signedAt)}
            {a.versionNumber != null ? ` · v${a.versionNumber}` : ''}
          </div>
          {a.comments && <div className="mt-1 text-xs text-ink-soft">“{a.comments}”</div>}
        </li>
      ))}
    </ul>
  );

  if (bare) {
    return (
      <>
        <CardSection title="Sign-off" action={approveAction}>
          {approvalChain}
        </CardSection>
        <CoverPageActions doc={doc} />
        <EvidenceBinderActions doc={doc} />
        {signing && <ApproveModal doc={doc} onClose={() => setSigning(false)} />}
      </>
    );
  }

  return (
    <div className="card space-y-4 p-5">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">Sign-off</h2>
          <p className="mt-1 text-xs text-ink-muted">Approval chain &amp; compliance cover page.</p>
        </div>
        {approveAction}
      </div>

      <div className="border-t border-slate-100 pt-3">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
          Approval chain
        </h3>
        {approvalChain}
      </div>

      <CoverPageActions doc={doc} />
      <EvidenceBinderActions doc={doc} />

      {signing && <ApproveModal doc={doc} onClose={() => setSigning(false)} />}
    </div>
  );
}

/** Cover-page preview + cover-prepended export buttons. */
function CoverPageActions({ doc }: { doc: DocumentDetail }) {
  const [error, setError] = useState<string | null>(null);

  const preview = useMutation({
    mutationFn: () => fetchCoverPage(doc.id),
    onSuccess: (blob) => {
      setError(null);
      // Hidden-anchor download (a post-await window.open would be popup-blocked).
      downloadBlob(blob, `${fileStem(doc)}-cover.pdf`);
    },
    onError: () => setError('Could not generate the cover page.'),
  });
  const exportPdf = useMutation({
    mutationFn: () => fetchExport(doc.id),
    onSuccess: (blob) => {
      setError(null);
      downloadBlob(blob, `${fileStem(doc)}-export.pdf`);
    },
    onError: () => setError('Could not export the document.'),
  });

  return (
    <div className="border-t border-slate-100 pt-3">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
        Cover page
      </h3>
      <div className="flex flex-wrap gap-2">
        <button
          className="btn-secondary !py-1.5 text-sm"
          onClick={() => preview.mutate()}
          disabled={preview.isPending}
        >
          {preview.isPending ? 'Preparing…' : 'Download cover page'}
        </button>
        <button
          className="btn-secondary !py-1.5 text-sm"
          onClick={() => exportPdf.mutate()}
          disabled={exportPdf.isPending}
        >
          {exportPdf.isPending ? 'Exporting…' : 'Export with cover page'}
        </button>
      </div>
      {error && (
        <p className="mt-2 text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function EvidenceBinderActions({ doc }: { doc: DocumentDetail }) {
  const { hasPermission } = useAuth();
  const canExport = hasPermission(PERMISSIONS.EVIDENCE_EXPORT);
  const [open, setOpen] = useState(false);
  const history = useQuery({
    queryKey: ['evidence-binders', doc.id],
    queryFn: () => listEvidenceBinders(doc.id),
    enabled: canExport,
  });
  if (!canExport) return null;
  return (
    <div className="border-t border-slate-100 pt-3">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
        Evidence binder
      </h3>
      <button className="btn-secondary !py-1.5 text-sm" onClick={() => setOpen(true)}>
        Export binder
      </button>
      {history.data && history.data.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs text-ink-muted">
          {history.data.slice(0, 3).map((item) => (
            <li key={item.id}>
              {item.fileName} - {item.status} - {formatDateTime(item.createdAt)}
            </li>
          ))}
        </ul>
      )}
      {open && <EvidenceBinderModal doc={doc} onClose={() => setOpen(false)} />}
    </div>
  );
}

function EvidenceBinderModal({ doc, onClose }: { doc: DocumentDetail; onClose: () => void }) {
  const [options, setOptions] = useState<EvidenceBinderOptions>({
    format: 'zip',
    includePolicyPdf: true,
    includeCoverPage: true,
    includeApprovalChain: true,
    includeAcknowledgmentRoster: true,
    includeReviewHistory: true,
    includeRevisionHistory: true,
    includeAuditLog: true,
  });
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () => exportEvidenceBinder(doc.id, options),
    onSuccess: (blob) => {
      const ext = options.format === 'zip' ? 'zip' : 'pdf';
      downloadBlob(blob, `${fileStem(doc)}-evidence-binder.${ext}`);
      onClose();
    },
    onError: (err) => setError(apiErrorMessage(err, 'Could not export the evidence binder.')),
  });
  const toggle = (key: keyof EvidenceBinderOptions) =>
    setOptions((prev) => ({ ...prev, [key]: !prev[key] }));
  return (
    <Modal open onClose={onClose} titleId="binder-title" busy={mutation.isPending}>
      <div className="w-[min(32rem,92vw)]">
        <h2 id="binder-title" className="text-base font-semibold text-ink">
          Export evidence binder
        </h2>
        <div className="mt-4">
          <label htmlFor="binder-format" className="label">
            Format
          </label>
          <select
            id="binder-format"
            className="input"
            value={options.format}
            onChange={(e) =>
              setOptions({ ...options, format: e.target.value as EvidenceBinderOptions['format'] })
            }
          >
            <option value="zip">ZIP evidence package</option>
            <option value="combined_pdf">Combined PDF</option>
          </select>
        </div>
        <div className="mt-4 grid gap-2 text-sm text-ink-soft sm:grid-cols-2">
          {[
            ['includePolicyPdf', 'Policy PDF'],
            ['includeCoverPage', 'Cover page'],
            ['includeApprovalChain', 'Approval chain'],
            ['includeAcknowledgmentRoster', 'Acknowledgment roster'],
            ['includeReviewHistory', 'Review history'],
            ['includeRevisionHistory', 'Revision history'],
            ['includeAuditLog', 'Audit log'],
          ].map(([key, label]) => (
            <label key={key} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={Boolean(options[key as keyof EvidenceBinderOptions])}
                onChange={() => toggle(key as keyof EvidenceBinderOptions)}
              />
              {label}
            </label>
          ))}
        </div>
        {error && (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            {error}
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </button>
          <button className="btn-primary" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending ? 'Exporting...' : 'Export'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Approve/publish sign modal capturing the typed signature (name/role/comments). */
function ApproveModal({ doc, onClose }: { doc: DocumentDetail; onClose: () => void }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [signatureName, setSignatureName] = useState(user?.name ?? '');
  const [signatureRole, setSignatureRole] = useState('');
  const [comments, setComments] = useState('');
  const [publish, setPublish] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      approveDocument(doc.id, {
        signatureName: signatureName.trim() || undefined,
        signatureRole: signatureRole.trim() || undefined,
        comments: comments.trim() || undefined,
        publish,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['attestations', doc.id] });
      void queryClient.invalidateQueries({ queryKey: ['document', doc.id] });
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      void queryClient.invalidateQueries({ queryKey: ['ack-status', doc.id] });
      onClose();
    },
    onError: (err) => {
      const status = (err as AxiosError).response?.status;
      setError(
        status === 400
          ? 'This document has no version to approve. Upload a version first.'
          : status === 403
            ? 'You do not have permission to approve this document.'
            : 'Could not record the approval. Please try again.',
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
    <Modal open onClose={onClose} titleId="approve-title" busy={mutation.isPending}>
      <form onSubmit={onSubmit} aria-label="Approve document">
        <h2 id="approve-title" className="text-base font-semibold text-ink">
          Approve document
        </h2>
        <p className="mt-1 text-sm text-ink-soft">{doc.title}</p>
        <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-ink-muted">
          Your name, role, timestamp, and IP are recorded as an immutable sign-off (compliance
          evidence). This cannot be edited or deleted.
        </p>
        {doc.unresolvedAnnotationCount > 0 && (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
            {doc.unresolvedAnnotationCount} unresolved annotation
            {doc.unresolvedAnnotationCount === 1 ? '' : 's'} on the current version.
          </div>
        )}
        <CompareBeforeSignoff doc={doc} />

        {error && (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            {error}
          </div>
        )}

        <div className="mt-4">
          <label htmlFor="ap-name" className="label">
            Signature (your name) <span className="text-red-600">*</span>
          </label>
          <input
            id="ap-name"
            className="input"
            value={signatureName}
            onChange={(e) => setSignatureName(e.target.value)}
            required
          />
        </div>
        <div className="mt-3">
          <label htmlFor="ap-role" className="label">
            Role / title <span className="font-normal text-ink-muted">(optional)</span>
          </label>
          <input
            id="ap-role"
            className="input"
            value={signatureRole}
            onChange={(e) => setSignatureRole(e.target.value)}
            placeholder="e.g. Compliance Officer"
          />
        </div>
        <div className="mt-3">
          <label htmlFor="ap-comments" className="label">
            Comments <span className="font-normal text-ink-muted">(optional)</span>
          </label>
          <textarea
            id="ap-comments"
            className="input min-h-[70px]"
            value={comments}
            onChange={(e) => setComments(e.target.value)}
          />
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm text-ink-soft">
          <input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} />
          Publish (staff must re-acknowledge the current version)
        </label>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={mutation.isPending}>
            {mutation.isPending ? 'Signing…' : publish ? 'Approve & publish' : 'Approve'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CompareBeforeSignoff({ doc }: { doc: DocumentDetail }) {
  const current = doc.currentVersion;
  const previous = doc.versions.find((v) => v.id !== current?.id);
  const query = useQuery({
    queryKey: ['approve-compare', doc.id, previous?.id, current?.id],
    queryFn: () => compareVersions(doc.id, previous!.id, current!.id),
    enabled: !!current && !!previous,
  });
  if (!current || !previous) {
    return (
      <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-ink-muted">
        No prior version is available for redline comparison.
      </div>
    );
  }
  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
      <div className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
        Changes reviewed before sign-off
      </div>
      {query.isLoading ? (
        <p className="mt-1 text-xs text-ink-muted">Loading v{previous.versionNumber} to v{current.versionNumber}...</p>
      ) : query.isError || !query.data ? (
        <p className="mt-1 text-xs text-red-600">Could not load the version comparison.</p>
      ) : (
        <div className="mt-1 text-xs text-ink-soft">
          v{query.data.fromVersionNumber} to v{query.data.toVersionNumber}: {query.data.summary.added} added,{' '}
          {query.data.summary.removed} removed, {query.data.summary.changed} changed.
          {query.data.warnings.length > 0 && (
            <div className="mt-1 text-amber-800">{query.data.warnings[0]}</div>
          )}
        </div>
      )}
    </div>
  );
}
