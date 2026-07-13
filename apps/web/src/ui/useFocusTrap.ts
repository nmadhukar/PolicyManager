import { RefObject, useEffect, useRef } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Accessible focus management for modal / overlay surfaces (AGENTS.md §10c):
 *
 * - on open, moves focus into the container (first focusable, else the container);
 * - traps Tab / Shift+Tab within the container so focus can't escape behind it;
 * - routes Escape to `onEscape` (kept current via a ref, so callers may pass a
 *   fresh closure each render without re-running the trap);
 * - restores focus to the previously-focused element on close.
 *
 * The container must be focusable for the fallback; a `tabindex="-1"` is added if
 * one isn't present.
 */
export function useFocusTrap(
  active: boolean,
  containerRef: RefObject<HTMLElement>,
  onEscape?: () => void,
): void {
  // Keep the latest Escape handler without making it a trap dependency.
  const onEscapeRef = useRef(onEscape);
  useEffect(() => {
    onEscapeRef.current = onEscape;
  });

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (container && !container.hasAttribute('tabindex')) {
      container.setAttribute('tabindex', '-1');
    }
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = (): HTMLElement[] =>
      container ? Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];

    // Move focus into the dialog.
    const initial = focusables()[0] ?? container;
    initial?.focus?.();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onEscapeRef.current?.();
        return;
      }
      if (e.key !== 'Tab' || !container) return;

      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        container.focus?.();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;

      if (e.shiftKey) {
        if (activeEl === first || !container.contains(activeEl)) {
          e.preventDefault();
          last.focus();
        }
      } else if (activeEl === last || !container.contains(activeEl)) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      previouslyFocused?.focus?.();
    };
  }, [active, containerRef]);
}
