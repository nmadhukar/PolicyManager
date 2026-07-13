import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type ToastTone = 'error' | 'success' | 'info';

export interface ToastItem {
  id: string;
  message: string;
  tone: ToastTone;
}

export interface ToastApi {
  /** Show a toast with an explicit tone (defaults to info). */
  toast: (message: string, tone?: ToastTone) => void;
  error: (message: string) => void;
  success: (message: string) => void;
  info: (message: string) => void;
  dismiss: (id: string) => void;
}

// A working no-op default so `useToast()` is safe outside a provider (e.g. in
// focused component tests) — calls simply do nothing.
const NOOP: ToastApi = {
  toast: () => undefined,
  error: () => undefined,
  success: () => undefined,
  info: () => undefined,
  dismiss: () => undefined,
};

const ToastContext = createContext<ToastApi>(NOOP);

/** Access the app-wide toast API. Safe to call without a provider (no-op). */
export function useToast(): ToastApi {
  return useContext(ToastContext);
}

let counter = 0;

/**
 * Lightweight, dependency-free toast system for transient feedback — primarily
 * surfacing otherwise-silent mutation failures (AGENTS.md §10c: never a blank or
 * raw-error screen). Error toasts get `role="alert"` and linger longer.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    setToasts((list) => list.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (message: string, tone: ToastTone) => {
      const id = `toast-${++counter}`;
      setToasts((list) => [...list, { id, message, tone }]);
      const timer = setTimeout(() => dismiss(id), tone === 'error' ? 8000 : 4000);
      timers.current.set(id, timer);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      toast: (message, tone = 'info') => push(message, tone),
      error: (message) => push(message, 'error'),
      success: (message) => push(message, 'success'),
      info: (message) => push(message, 'info'),
      dismiss,
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

function toneClasses(tone: ToastTone): string {
  switch (tone) {
    case 'error':
      return 'border-red-200 bg-red-50 text-red-800';
    case 'success':
      return 'border-green-200 bg-green-50 text-green-800';
    default:
      return 'border-slate-200 bg-white text-ink';
  }
}

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex flex-col items-center gap-2 p-4 sm:items-end"
      aria-live="polite"
      aria-atomic="false"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.tone === 'error' ? 'alert' : 'status'}
          className={`pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border px-4 py-3 text-sm shadow-card ${toneClasses(
            t.tone,
          )}`}
        >
          <span className="min-w-0 flex-1">{t.message}</span>
          <button
            type="button"
            onClick={() => onDismiss(t.id)}
            className="shrink-0 opacity-70 hover:opacity-100"
            aria-label="Dismiss notification"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
