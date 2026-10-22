import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

// Generic accessible modal dialog.
//
// - role="dialog", aria-modal, aria-labelledby (the title), optional aria-describedby
// - Esc and a backdrop click close it (unless `dismissible` is false, e.g. while a
//   request that cannot be cancelled is in flight)
// - focus moves into the dialog on open — to the first `[data-autofocus]` element,
//   else the dialog itself — and returns to the element that opened it on close
// - Tab / Shift+Tab are trapped inside the dialog
//
// Rendered into document.body through a portal so it sits above drawers and the
// mobile full-screen KG drawer regardless of where it is mounted.

const FOCUSABLE = [
  'a[href]', 'area[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', 'iframe', '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter(el => !el.hasAttribute('inert') && el.getClientRects().length > 0);
}

export interface ModalProps {
  title: ReactNode;
  /** Small line above the title, e.g. "Step 1 of 2". */
  eyebrow?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** When false, Esc, the backdrop and the close button do nothing. Default true. */
  dismissible?: boolean;
  size?: 'md' | 'lg';
  /** id of an element describing the dialog. */
  describedBy?: string;
  className?: string;
}

export function Modal({
  title, eyebrow, onClose, children, footer, dismissible = true, size = 'md', describedBy, className,
}: ModalProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // Latest callbacks/flags in refs so the document listeners and the focus
  // effect are installed once per open, not on every render.
  const onCloseRef = useRef(onClose);
  const dismissibleRef = useRef(dismissible);
  useEffect(() => {
    onCloseRef.current = onClose;
    dismissibleRef.current = dismissible;
  });
  // Where the pointer went down: a drag that starts inside the dialog and ends
  // on the backdrop (text selection) must not close it.
  const pointerDownOnBackdrop = useRef(false);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (dialog) {
      const preferred = dialog.querySelector<HTMLElement>('[data-autofocus]');
      (preferred ?? dialog).focus();
    }

    function onKeyDown(e: KeyboardEvent) {
      const root = dialogRef.current;
      if (!root) return;
      if (e.key === 'Escape') {
        if (dismissibleRef.current) {
          e.stopPropagation();
          onCloseRef.current();
        }
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusableIn(root);
      const active = document.activeElement;
      if (items.length === 0) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const inside = active instanceof Node && root.contains(active);
      if (!inside) {
        // Focus escaped (e.g. the focused element unmounted): bring it back.
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && (active === first || active === root)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      // Restore focus to the opener if it is still on the page.
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={e => { pointerDownOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={e => {
        if (e.target === e.currentTarget && pointerDownOnBackdrop.current && dismissibleRef.current) {
          onCloseRef.current();
        }
        pointerDownOnBackdrop.current = false;
      }}
    >
      <div
        ref={dialogRef}
        className={`modal modal-${size}${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        tabIndex={-1}
      >
        <div className="modal-header">
          <div className="modal-heading">
            {eyebrow && <div className="modal-eyebrow">{eyebrow}</div>}
            <h2 id={titleId} className="modal-title">{title}</h2>
          </div>
          <button
            type="button"
            className="drawer-close"
            onClick={() => { if (dismissibleRef.current) onCloseRef.current(); }}
            disabled={!dismissible}
            aria-label="Close dialog"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
