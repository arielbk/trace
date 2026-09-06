import { FileWarning, Loader2, RotateCcw, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { downloadTaskExport } from "../lib/api.ts";
import { cn } from "../lib/utils.ts";
import {
  ArchiveIcon,
  DownloadIcon,
  MoreIcon,
  SuccessCheckIcon,
  TranscriptIcon,
  UnarchiveIcon,
} from "./icons.tsx";
import { ConfirmationDialog } from "./ui/ConfirmationDialog.tsx";
import { Dropdown, DropdownContent, DropdownTrigger } from "./ui/Dropdown.tsx";

export const TRANSCRIPT_EXPORT_WARNING =
  "Session transcripts can contain secrets, local file paths, and machine identifiers.";

const MENU_ITEM =
  "flex w-full items-start gap-2.5 rounded-sm border-0 bg-transparent px-2.5 py-2 text-left text-text cursor-pointer hover:bg-chip-bg focus-visible:outline-none focus-visible:bg-accent-soft focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent disabled:cursor-wait disabled:opacity-50";

const EXPORT_SUCCESS_MS = 2400;

type ExportKind = "task" | "transcripts";

type ExportStatus =
  | { phase: "idle" }
  | { phase: "preparing"; kind: ExportKind }
  | { phase: "success"; kind: ExportKind }
  | { phase: "error"; kind: ExportKind };

/**
 * Overflow for the quieter task-page actions. Re-enter stays a first-class
 * button; Export, Export with transcripts, and Archive live behind a "…"
 * trigger so the header row stays a single primary action.
 *
 * Transcripts remain a distinct export item, with the sensitive-data warning
 * moved into a confirmation dialog so the menu stays concise.
 */
export function TaskActionsMenu({
  taskRef,
  isArchived,
  onArchive,
  onUnarchive,
  className,
}: {
  taskRef: string;
  isArchived: boolean;
  onArchive?: () => void | Promise<void>;
  onUnarchive?: () => void | Promise<void>;
  className?: string;
}) {
  const exportLabelId = useId();
  const exportDescriptionId = useId();
  const transcriptLabelId = useId();
  const transcriptDescriptionId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const successTimer = useRef<number | null>(null);
  const [transcriptDialogOpen, setTranscriptDialogOpen] = useState(false);
  const [exportStatus, setExportStatus] = useState<ExportStatus>({
    phase: "idle",
  });
  const archiveAction = isArchived ? onUnarchive : onArchive;
  const exportPending = exportStatus.phase === "preparing";

  useEffect(() => {
    return () => {
      if (successTimer.current !== null) {
        window.clearTimeout(successTimer.current);
      }
    };
  }, []);

  async function runExport(kind: ExportKind) {
    if (exportPending) return;

    if (successTimer.current !== null) {
      window.clearTimeout(successTimer.current);
      successTimer.current = null;
    }

    setExportStatus({ phase: "preparing", kind });
    try {
      await downloadTaskExport(
        taskRef,
        kind === "transcripts" ? { includeTranscripts: true } : undefined,
      );
      setExportStatus({ phase: "success", kind });
      successTimer.current = window.setTimeout(() => {
        successTimer.current = null;
        setExportStatus({ phase: "idle" });
      }, EXPORT_SUCCESS_MS);
    } catch {
      setExportStatus({ phase: "error", kind });
    }
  }

  return (
    <>
      <Dropdown>
        <DropdownTrigger
          ref={triggerRef}
          className={cn(
            "inline-flex items-center justify-center size-8 rounded-lg border border-border bg-surface text-text-muted cursor-pointer transition-colors hover:text-accent hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
            className,
          )}
          aria-label="More actions"
        >
          <MoreIcon />
        </DropdownTrigger>
        <DropdownContent
          aria-label="Task actions"
          origin="top-right"
          align="end"
          sideOffset={8}
          className="w-72 p-1.5"
        >
          {({ close }) => (
            <div className="flex flex-col">
              <button
                type="button"
                className={MENU_ITEM}
                aria-labelledby={exportLabelId}
                aria-describedby={exportDescriptionId}
                disabled={exportPending}
                onClick={() => {
                  close();
                  void runExport("task");
                }}
              >
                <span className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center text-text-muted">
                  <DownloadIcon />
                </span>
                <span className="min-w-0 flex flex-col gap-0.5">
                  <span id={exportLabelId} className="text-sm font-semibold">
                    Export task
                  </span>
                  <span
                    id={exportDescriptionId}
                    className="text-crumb font-normal leading-snug text-text-muted"
                  >
                    Docs, metadata, and session summaries
                  </span>
                </span>
              </button>
              <button
                type="button"
                className={MENU_ITEM}
                aria-labelledby={transcriptLabelId}
                aria-describedby={transcriptDescriptionId}
                disabled={exportPending}
                onClick={() => {
                  close();
                  setTranscriptDialogOpen(true);
                }}
              >
                <span className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center text-warning">
                  <TranscriptIcon />
                </span>
                <span className="min-w-0 flex flex-col gap-0.5">
                  <span
                    id={transcriptLabelId}
                    className="text-sm font-semibold"
                  >
                    Export with transcripts
                  </span>
                  <span
                    id={transcriptDescriptionId}
                    className="text-crumb font-normal leading-snug text-text-muted"
                  >
                    Includes unredacted session logs
                  </span>
                </span>
              </button>
              {archiveAction ? (
                <>
                  <div
                    className="my-1.5 h-px bg-border-subtle"
                    role="separator"
                  />
                  <button
                    type="button"
                    className={cn(MENU_ITEM, "items-center py-1.5")}
                    aria-label={isArchived ? "Unarchive task" : "Archive task"}
                    onClick={() => {
                      void Promise.resolve(archiveAction());
                      close();
                    }}
                  >
                    <span className="inline-flex size-4 shrink-0 items-center justify-center text-text-muted">
                      {isArchived ? (
                        <UnarchiveIcon size={13} />
                      ) : (
                        <ArchiveIcon size={13} />
                      )}
                    </span>
                    <span className="text-sm font-semibold">
                      {isArchived ? "Unarchive" : "Archive"}
                    </span>
                  </button>
                </>
              ) : null}
            </div>
          )}
        </DropdownContent>
      </Dropdown>

      <ConfirmationDialog
        open={transcriptDialogOpen}
        onOpenChange={setTranscriptDialogOpen}
        title="Include unredacted transcripts?"
        description={TRANSCRIPT_EXPORT_WARNING}
        icon={<FileWarning size={16} aria-hidden="true" />}
        confirmLabel="Export transcripts"
        onConfirm={() => void runExport("transcripts")}
        returnFocusTo={triggerRef}
      />

      <ExportStatusToast
        status={exportStatus}
        onRetry={(kind) => void runExport(kind)}
        onDismiss={() => setExportStatus({ phase: "idle" })}
      />
    </>
  );
}

function ExportStatusToast({
  status,
  onRetry,
  onDismiss,
}: {
  status: ExportStatus;
  onRetry: (kind: ExportKind) => void;
  onDismiss: () => void;
}) {
  return (
    <div aria-live="polite" aria-atomic="true">
      {status.phase === "idle" ? null : (
        <div
          className="fixed bottom-5 right-5 z-[70] flex min-h-11 max-w-[min(22rem,calc(100vw-2rem))] items-center gap-2.5 rounded-lg border border-border bg-surface px-3 py-2.5 text-caption text-text shadow-lg"
          data-export-status={status.phase}
        >
          <span className="inline-flex size-5 shrink-0 items-center justify-center text-accent">
            {status.phase === "preparing" ? (
              <Loader2
                size={16}
                className="t-sync-spinner animate-spin"
                aria-hidden="true"
              />
            ) : status.phase === "success" ? (
              <SuccessCheckIcon shown />
            ) : (
              <FileWarning
                size={16}
                className="text-warning"
                aria-hidden="true"
              />
            )}
          </span>
          <span className="min-w-0 flex-1 font-semibold">
            {status.phase === "preparing"
              ? status.kind === "transcripts"
                ? "Preparing transcript export…"
                : "Preparing task export…"
              : status.phase === "success"
                ? "Download started"
                : "Export failed"}
          </span>
          {status.phase === "error" ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-control border border-border bg-transparent px-2 py-1 text-crumb font-semibold text-text cursor-pointer hover:border-border-strong"
              onClick={() => onRetry(status.kind)}
            >
              <RotateCcw size={12} aria-hidden="true" />
              Retry
            </button>
          ) : null}
          {status.phase === "error" ? (
            <button
              type="button"
              className="inline-flex size-6 items-center justify-center rounded-md border-0 bg-transparent text-text-muted cursor-pointer hover:bg-chip-bg hover:text-text"
              aria-label="Dismiss export status"
              onClick={onDismiss}
            >
              <X size={13} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
