import type { UseQueryResult } from "@tanstack/react-query";
import type { MouseEvent, RefObject } from "react";
import { truncatePath } from "../format.ts";
import {
  HttpError,
  type DocContents,
  useDocContents,
  useToggleCheckbox,
} from "../lib/api.ts";
import { resolveTaskDocLink } from "../lib/doc-link-resolver.ts";
import { CopyChip } from "./CopyChip.tsx";
import { Sheet } from "./ui/Sheet.tsx";

/**
 * The rendered contents of a task doc, in the board's right-side Sheet. Mounted
 * only while a doc is selected. AnimatePresence in the parent keeps it mounted
 * long enough for Motion to play the exit animation after close.
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
  const toggleCheckbox = useToggleCheckbox();

  return (
    <Sheet
      onOpenChange={onOpenChange}
      title={<CopyChip value={docPath} display={truncatePath(docPath)} />}
      description={`Read-only contents of ${docPath}`}
      returnFocusTo={triggerRef}
    >
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
    </Sheet>
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
  const input = target
    .closest("li")
    ?.querySelector(":scope > input[type='checkbox']");
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
