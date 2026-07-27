import * as DialogPrimitive from "@radix-ui/react-dialog";
import { motion, useReducedMotion } from "motion/react";
import type { ReactNode, RefObject } from "react";
import { cn } from "../../lib/utils.ts";

const sheetEase: [number, number, number, number] = [0.22, 1, 0.36, 1];

/**
 * A right-side overlay panel: scrim, sliding surface, and a header with a title
 * and close button. The caller supplies the body and nothing else.
 *
 * Like `Dropdown`, this exists so the motion is defined once. The panel is
 * always force-mounted and animates with Motion rather than Radix's own
 * mount/unmount, which means the caller has to keep it rendered through its
 * exit — wrap it in an `AnimatePresence` and unmount it when the thing it is
 * showing goes away.
 */
export function Sheet({
  onOpenChange,
  title,
  description,
  returnFocusTo,
  className,
  children,
}: {
  onOpenChange: (open: boolean) => void;
  /** Header content; rendered as the dialog's accessible title. */
  title: ReactNode;
  /** Screen-reader-only summary of what the panel is showing. */
  description: string;
  /** Focused when the panel closes, so dismissal returns where it came from. */
  returnFocusTo?: RefObject<HTMLElement | null>;
  className?: string;
  children: ReactNode;
}) {
  const shouldReduceMotion = useReducedMotion();
  const transition = shouldReduceMotion
    ? { duration: 0 }
    : { duration: 0.35, ease: sheetEase };
  const overlayTransition = shouldReduceMotion
    ? { duration: 0 }
    : { duration: 0.4, ease: sheetEase };

  return (
    <DialogPrimitive.Root open onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal forceMount>
        <DialogPrimitive.Overlay asChild forceMount>
          <motion.div
            className="fixed inset-0 z-50 bg-black/50"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={overlayTransition}
          />
        </DialogPrimitive.Overlay>
        <DialogPrimitive.Content
          asChild
          forceMount
          onCloseAutoFocus={
            returnFocusTo
              ? (event) => {
                  event.preventDefault();
                  returnFocusTo.current?.focus();
                }
              : undefined
          }
        >
          <motion.div
            className={cn(
              "fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-border bg-bg shadow-lg sm:max-w-2xl",
              className,
            )}
            initial={{ opacity: 0, x: 24, filter: "blur(2px)" }}
            animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, x: 24, filter: "blur(2px)" }}
            transition={transition}
          >
            <header className="flex items-start justify-between gap-3 border-b border-border px-6 py-4">
              <DialogPrimitive.Title className="m-0 min-w-0 text-row-title font-bold tracking-tight">
                {title}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="sr-only">
                {description}
              </DialogPrimitive.Description>
              <DialogPrimitive.Close
                aria-label="Close"
                className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md border border-chip-border bg-surface text-text-muted hover:border-border-strong hover:text-text"
              >
                <CloseIcon />
              </DialogPrimitive.Close>
            </header>
            <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
          </motion.div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function CloseIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 6 6 18" />
      <path d="M6 6l12 12" />
    </svg>
  );
}
