import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { cn } from "../../lib/utils.ts";

/**
 * Compact confirmation surface for actions that need one deliberate pause.
 * Radix owns modal semantics and focus containment; `.t-modal` owns the shared
 * open/close motion, including the short force-mounted exit.
 */
export function ConfirmationDialog({
  open,
  onOpenChange,
  title,
  description,
  icon,
  confirmLabel,
  onConfirm,
  returnFocusTo,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  icon?: ReactNode;
  confirmLabel: ReactNode;
  onConfirm: () => void;
  returnFocusTo?: RefObject<HTMLElement | null>;
}) {
  const mounted = useModalMounted(open);

  if (!mounted) return null;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal forceMount>
        <DialogPrimitive.Overlay
          forceMount
          className="fixed inset-0 z-[60] bg-black/50 opacity-0 transition-opacity duration-150 data-[state=open]:opacity-100 motion-reduce:transition-none"
        />
        <DialogPrimitive.Content
          forceMount
          onCloseAutoFocus={
            returnFocusTo
              ? (event) => {
                  event.preventDefault();
                  returnFocusTo.current?.focus();
                }
              : undefined
          }
          className={cn(
            "t-modal fixed left-1/2 top-1/2 z-[61] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-surface p-5 text-text shadow-lg",
            open ? "is-open" : "is-closing",
          )}
        >
          <div className="flex items-start gap-3">
            {icon ? (
              <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-chip-bg text-warning">
                {icon}
              </span>
            ) : null}
            <div className="min-w-0">
              <DialogPrimitive.Title className="m-0 text-row-title font-bold tracking-tight">
                {title}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="mt-1.5 mb-0 text-sm leading-relaxed text-text-muted">
                {description}
              </DialogPrimitive.Description>
            </div>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <DialogPrimitive.Close asChild>
              <button
                type="button"
                className="rounded-control border border-border bg-surface px-3 py-1.5 text-caption font-semibold text-text cursor-pointer hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
              >
                Cancel
              </button>
            </DialogPrimitive.Close>
            <button
              type="button"
              className="rounded-control border border-transparent bg-accent-soft px-3 py-1.5 text-caption font-semibold text-accent cursor-pointer hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
              onClick={() => {
                onOpenChange(false);
                onConfirm();
              }}
            >
              {confirmLabel}
            </button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function useModalMounted(open: boolean): boolean {
  const [mounted, setMounted] = useState(open);
  const closeTimer = useRef<number | null>(null);

  useEffect(() => {
    if (open) {
      if (closeTimer.current !== null) {
        window.clearTimeout(closeTimer.current);
        closeTimer.current = null;
      }
      setMounted(true);
      return;
    }

    if (!mounted) return;

    const closeMs =
      parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue(
          "--modal-close-dur",
        ),
      ) || 150;
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setMounted(false);
    }, closeMs);
  }, [mounted, open]);

  useEffect(() => {
    return () => {
      if (closeTimer.current !== null) {
        window.clearTimeout(closeTimer.current);
      }
    };
  }, []);

  return mounted;
}
