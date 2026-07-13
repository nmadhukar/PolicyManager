import { ReactNode, useId } from 'react';
import { Modal } from './Modal';

/** Confirmation dialog for impactful actions (disable, lock, reset). */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  tone = 'primary',
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  return (
    <Modal open={open} onClose={onCancel} titleId={titleId} busy={busy}>
      <h2 id={titleId} className="text-base font-semibold text-ink">
        {title}
      </h2>
      <div className="mt-2 text-sm text-ink-soft">{body}</div>
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className={tone === 'danger' ? 'btn-danger' : 'btn-primary'}
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
