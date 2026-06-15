import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { UseQueryResult } from "@tanstack/react-query";
import type { RefObject } from "react";
import { truncatePath } from "../format.ts";
import { HttpError, type DocContents, useDocContents } from "../lib/api.ts";
import { CopyChip } from "./CopyChip.tsx";

/**
 * Right-side Sheet showing the rendered contents of a task doc. Mounted only
 * while a doc is selected — `open` is always true while mounted, and closing
 * (Escape/overlay/Close button) unmounts it via `onOpenChange`.
 */
export function DocViewerSheet({
  taskRef,
  docPath,
  onOpenChange,
  triggerRef,
}: {
  taskRef: string;
  docPath: string;
  onOpenChange: (open: boolean) => void;
  triggerRef: RefObject<HTMLElement | null>;
}) {
  const query = useDocContents(taskRef, docPath);

  return (
    <DialogPrimitive.Root open onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 animate-in fade-in-0" />
        <DialogPrimitive.Content
          className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-border bg-bg shadow-lg sm:max-w-2xl animate-in slide-in-from-right duration-300"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.focus();
          }}
        >
          <header className="flex items-start justify-between gap-3 border-b border-border px-6 py-4">
            <DialogPrimitive.Title className="m-0 min-w-0 text-row-title font-bold tracking-tight">
              <CopyChip value={docPath} display={truncatePath(docPath)} />
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">
              Read-only contents of {docPath}
            </DialogPrimitive.Description>
            <DialogPrimitive.Close
              aria-label="Close"
              className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md border border-chip-border bg-surface text-text-muted hover:border-border-strong hover:text-text"
            >
              <CloseIcon />
            </DialogPrimitive.Close>
          </header>
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <DocViewerBody query={query} />
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function DocViewerBody({ query }: { query: UseQueryResult<DocContents, Error> }) {
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
        className="doc-viewer-prose text-base text-text leading-relaxed"
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
