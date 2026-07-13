import { ReactNode, useRef } from 'react';
import { useFocusTrap } from './useFocusTrap';

/**
 * Minimal accessible modal: role="dialog" + aria-modal. Manages focus (traps Tab,
 * moves focus in on open, restores it on close — see useFocusTrap) and closes on
 * Escape and on backdrop click. While `busy` (a modal action is in flight) Escape
 * and backdrop dismissal are ignored so the action can't be interrupted midway.
 * Callers own the heading via `titleId` for aria-labelledby.
 */
export function Modal({
  open,
  onClose,
  titleId,
  busy = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  titleId: string;
  /** When true, ignore Escape / backdrop dismissal (an action is running). */
  busy?: boolean;
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
      className="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-4"
      onMouseDown={requestClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="card w-full max-w-md p-6 focus:outline-none"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
