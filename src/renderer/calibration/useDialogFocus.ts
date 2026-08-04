/**
 * Shared modal-dialog focus behaviour for the calibration workspace.
 *
 * A dialog that declares `role="dialog" aria-modal="true"` but leaves focus
 * outside itself is a lie to assistive technology: the surrounding page stays
 * reachable by Tab and Escape does nothing. This hook supplies the three
 * behaviours that make the declaration true — initial focus, a real Tab /
 * Shift+Tab trap with Escape close, and focus restore to the invoking control.
 */
import React, { useCallback, useEffect } from 'react';

export const DIALOG_FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'button:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR),
  ).filter((element) => !element.closest('[aria-hidden="true"]'));
}

/**
 * Constrains Tab / Shift+Tab within `containerRef` and calls `onEscape` when
 * Escape is pressed, while `active` is true.
 */
export function useFocusTrap(
  containerRef: React.RefObject<HTMLElement | null>,
  active: boolean,
  onEscape: () => void,
): void {
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!active || !containerRef.current) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onEscape();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = focusableWithin(containerRef.current);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      if (event.shiftKey) {
        if (document.activeElement === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [active, containerRef, onEscape],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}

/**
 * Captures the element that opened the dialog, moves initial focus into it,
 * and restores focus to the opener when it closes — whether the dialog closes
 * by toggling `open` or by unmounting.
 */
export function useDialogFocusLifecycle(
  containerRef: React.RefObject<HTMLElement | null>,
  open: boolean,
): void {
  useEffect(() => {
    if (!open) return;
    const trigger = document.activeElement as HTMLElement | null;
    const container = containerRef.current;
    if (container) {
      const [first] = focusableWithin(container);
      first?.focus();
    }
    return () => {
      // Deferred so the restore lands after React has removed the dialog.
      window.setTimeout(() => {
        if (trigger?.isConnected === true) trigger.focus();
      }, 0);
    };
  }, [containerRef, open]);
}
