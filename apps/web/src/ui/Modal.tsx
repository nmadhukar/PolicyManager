import { ReactNode, useRef } from 'react';
import { useFocusTrap } from './useFocusTrap';

/**
 * Minimal accessible modal: role="dialog" + aria-modal. Manages focus (traps Tab,
 * moves focus in on open, restores it on close — see useFocusTrap) and closes on
 * Escape and on backdrop click. While `busy` (a modal action is in flight) Escape
 * and backdrop dismissal are ignored so the action can't be interrupted midway.
 * Callers own the heading via `titleId` for aria-labelledby.
 */
/**
 * Named card widths. The whole app should size modals from this vocabulary
 * rather than hand-rolling `max-w-*` / `w-[min(...)]` on inner content, so a
 * modal's box is always the sized element (no child wider than its container).
 */
const MODAL_MAX_WIDTH = {
  sm: 'max-w-md', //  ~28rem — confirm / ack / approve / api dialogs (default)
  md: 'max-w-lg', //  ~32rem — binder-style forms
  lg: 'max-w-3xl', // ~48rem — long-form content (matches TipTapEditor)
  xl: 'max-w-4xl', // ~56rem — wide diff / version compare
} as const;

export function Modal({
  open,
  onClose,
  titleId,
  busy = false,
  size = 'sm',
  children,
}: {
  open: boolean;
  onClose: () => void;
  titleId: string;
  /** When true, ignore Escape / backdrop dismissal (an action is running). */
  busy?: boolean;
  /** Card max-width. Defaults to 'sm' (max-w-md) — the historical width. */
  size?: keyof typeof MODAL_MAX_WIDTH;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  const requestClose = () => {
    if (!busy) onClose();
  };

  useFocusTrap(open, dialogRef, requestClose);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-slate-900/40 p-4"
      onMouseDown={requestClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`card w-full ${MODAL_MAX_WIDTH[size]} p-6 focus:outline-none`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
