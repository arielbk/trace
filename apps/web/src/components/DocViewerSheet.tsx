import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { UseQueryResult } from "@tanstack/react-query";
import { motion, useReducedMotion } from "motion/react";
import type { MouseEvent, RefObject } from "react";
import { truncatePath } from "../format.ts";
import { HttpError, type DocContents, useDocContents, useToggleCheckbox } from "../lib/api.ts";
import { resolveTaskDocLink } from "../lib/doc-link-resolver.ts";
import { CopyChip } from "./CopyChip.tsx";

const docViewerEase: [number, number, number, number] = [0.22, 1, 0.36, 1];

/**
 * Right-side Sheet showing the rendered contents of a task doc. Mounted only
 * while a doc is selected. AnimatePresence in the parent keeps it mounted long
 * enough for Motion to play the exit animation after close.
 */
export function DocViewerSheet({
  taskRef,
  docPath,
  knownDocPaths = [],
  onOpenChange,
  onNavigateDocRoute,
  triggerRef,
}: {
  taskRef: string;
  docPath: string;
  knownDocPaths?: readonly string[];
  onOpenChange: (open: boolean) => void;
  onNavigateDocRoute?: (route: string) => void;
  triggerRef: RefObject<HTMLElement | null>;
}) {
  const query = useDocContents(taskRef, docPath);
  // The resolved title arrives with the doc contents; until it loads (or on an
  // error) fall back to the filename so the heading is never empty.
  const title = query.data?.title ?? truncatePath(docPath);
  const description = query.data?.description;
  const toggleCheckbox = useToggleCheckbox();
  const shouldReduceMotion = useReducedMotion();
  const transition = shouldReduceMotion
    ? { duration: 0 }
    : { duration: 0.35, ease: docViewerEase };
  const overlayTransition = shouldReduceMotion
    ? { duration: 0 }
    : { duration: 0.4, ease: docViewerEase };

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
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.focus();
          }}
        >
          <motion.div
            className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-border bg-bg shadow-lg sm:max-w-2xl"
            initial={{ opacity: 0, x: 24, filter: "blur(2px)" }}
            animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, x: 24, filter: "blur(2px)" }}
            transition={transition}
          >
            <header className="flex items-start justify-between gap-3 border-b border-border px-6 py-4">
              <div className="flex min-w-0 flex-col gap-1.5">
                <DialogPrimitive.Title className="m-0 min-w-0 text-row-title font-bold tracking-tight">
                  {title}
                </DialogPrimitive.Title>
                {description ? (
                  <p
                    data-testid="doc-viewer-description"
                    className="m-0 text-sm text-text-muted leading-relaxed"
                  >
                    {description}
                  </p>
                ) : null}
                <DialogPrimitive.Description className="sr-only">
                  Read-only contents of {docPath}
                </DialogPrimitive.Description>
                <div className="text-xs">
                  <CopyChip value={docPath} display={truncatePath(docPath)} />
                </div>
              </div>
              <DialogPrimitive.Close
                aria-label="Close"
                className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md border border-chip-border bg-surface text-text-muted hover:border-border-strong hover:text-text"
              >
                <CloseIcon />
              </DialogPrimitive.Close>
            </header>
            <div className="flex-1 overflow-y-auto px-6 py-5">
              <DocViewerBody
                query={query}
                onClick={(event) => {
                  const checkbox = checkboxToggleFromClick(event);
                  if (checkbox) {
                    const { input, index, checked } = checkbox;
                    // The native click already flipped the input optimistically;
                    // persist that state and revert the input if the write fails.
                    toggleCheckbox.mutate(
                      { ref: taskRef, path: docPath, index, checked },
                      { onError: () => (input.checked = !checked) },
                    );
                    return;
                  }

                  if (!onNavigateDocRoute) return;
                  const route = docLinkRouteFromClick(event, {
                    taskRef,
                    docPath,
                    knownDocPaths,
                  });
                  if (!route) return;

                  event.preventDefault();
                  onNavigateDocRoute(route);
                }}
              />
            </div>
          </motion.div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function DocViewerBody({
  query,
  onClick,
}: {
  query: UseQueryResult<DocContents, Error>;
  onClick?: (event: MouseEvent<HTMLDivElement>) => void;
}) {
  if (query.isPending) {
    return <p className="text-text-muted">Loading…</p>;
  }

  if (query.isError) {
    return (
      <p role="alert" className="text-text-muted">
        {docErrorMessage(query.error)}
      </p>
    );
  }

  if (query.data.contentType.startsWith("text/html")) {
    return (
      <div
        className="doc-viewer-prose text-base text-text-muted leading-relaxed"
        onClick={onClick}
        dangerouslySetInnerHTML={{ __html: query.data.body }}
      />
    );
  }

  return (
    <div>
      <p className="m-0 mb-3 text-xs font-bold uppercase tracking-wide text-text-muted">
        Showing raw contents
      </p>
      <pre className="m-0 overflow-x-auto rounded-md border border-border-subtle bg-surface p-4 text-sm font-mono whitespace-pre-wrap break-words text-text">
        {query.data.body}
      </pre>
    </div>
  );
}

function docLinkRouteFromClick(
  event: MouseEvent<HTMLDivElement>,
  {
    taskRef,
    docPath,
    knownDocPaths,
  }: {
    taskRef: string;
    docPath: string;
    knownDocPaths: readonly string[];
  },
): string | null {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return null;
  }

  const target = event.target;
  if (!(target instanceof Element)) return null;

  const anchor = target.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) return null;

  return resolveTaskDocLink({
    href: anchor.getAttribute("href") ?? "",
    baseDocPath: docPath,
    knownDocPaths,
    taskRef,
  });
}

function checkboxToggleFromClick(
  event: MouseEvent<HTMLDivElement>,
): { input: HTMLInputElement; index: number; checked: boolean } | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;

  // Direct click on the box — the browser has already flipped it.
  if (target instanceof HTMLInputElement && target.type === "checkbox") {
    return readCheckbox(target, target.checked);
  }

  // Click elsewhere on the task-list line toggles the line's box, like a native
  // <label>. Anchors keep their own navigation behaviour.
  if (target.closest("a[href]")) return null;
  const input = target.closest("li")?.querySelector(":scope > input[type='checkbox']");
  if (!(input instanceof HTMLInputElement)) return null;
  // No native flip happened here, so toggle the input ourselves to keep the
  // optimistic UI in sync before persisting.
  const checked = !input.checked;
  input.checked = checked;
  return readCheckbox(input, checked);
}

function readCheckbox(
  input: HTMLInputElement,
  checked: boolean,
): { input: HTMLInputElement; index: number; checked: boolean } | null {
  const raw = input.getAttribute("data-checkbox-index");
  if (raw === null) return null;
  const index = Number(raw);
  if (!Number.isInteger(index) || index < 0) return null;
  return { input, index, checked };
}

function docErrorMessage(error: Error): string {
  if (error instanceof HttpError) {
    if (error.status === 404) return "This document could not be found.";
    if (error.status === 400) {
      return "This document path is outside the task's docs directory.";
    }
    return error.message || "This document could not be read.";
  }
  return "This document could not be read.";
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
