import { useId } from "react";
import { downloadTaskExport } from "../lib/api.ts";
import { cn } from "../lib/utils.ts";
import { ArchiveIcon, DownloadIcon, MoreIcon, UnarchiveIcon } from "./icons.tsx";
import { Dropdown, DropdownContent, DropdownTrigger } from "./ui/Dropdown.tsx";

/** Matches the CLI's `--include-transcripts` stderr warning. */
export const TRANSCRIPT_EXPORT_WARNING =
  "Warning: transcripts are copied verbatim and unredacted. They may contain secrets, absolute paths, and machine identifiers.";

const MENU_ITEM =
  "flex w-full items-center gap-2 rounded-sm border-0 bg-transparent px-2 py-1.5 text-left text-sm font-medium text-text cursor-pointer hover:bg-chip-bg";

/**
 * Overflow for the quieter task-page actions. Re-enter stays a first-class
 * button; Export, Export with transcripts, and Archive live behind a "…"
 * trigger so the header row stays a single primary action.
 *
 * Transcripts are a second export item rather than a checkbox you then confirm,
 * so the verbatim warning can sit on the dangerous choice instead of occupying
 * the page.
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
  const warningId = useId();
  const archiveAction = isArchived ? onUnarchive : onArchive;

  return (
    <Dropdown>
      <DropdownTrigger
        className={cn(
          "inline-flex items-center justify-center size-8 rounded-lg border border-border bg-surface text-text-muted cursor-pointer transition-colors hover:text-accent hover:border-border-strong",
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
        className="w-72 p-1"
      >
        {({ close }) => (
          <div className="flex flex-col">
            <button
              type="button"
              className={MENU_ITEM}
              onClick={() => {
                void downloadTaskExport(taskRef);
                close();
              }}
            >
              <DownloadIcon />
              Export
            </button>
            <div>
              <button
                type="button"
                className={MENU_ITEM}
                aria-describedby={warningId}
                onClick={() => {
                  void downloadTaskExport(taskRef, { includeTranscripts: true });
                  close();
                }}
              >
                <DownloadIcon />
                Export with transcripts
              </button>
              <p
                id={warningId}
                className="m-0 px-2 pb-2 pl-8 text-crumb font-normal text-text-muted leading-relaxed"
              >
                {TRANSCRIPT_EXPORT_WARNING}
              </p>
            </div>
            {archiveAction ? (
              <>
                <div
                  className="my-1 h-px bg-border-subtle"
                  role="separator"
                />
                <button
                  type="button"
                  className={MENU_ITEM}
                  aria-label={isArchived ? "Unarchive task" : "Archive task"}
                  onClick={() => {
                    void Promise.resolve(archiveAction());
                    close();
                  }}
                >
                  {isArchived ? (
                    <UnarchiveIcon size={13} />
                  ) : (
                    <ArchiveIcon size={13} />
                  )}
                  {isArchived ? "Unarchive" : "Archive"}
                </button>
              </>
            ) : null}
          </div>
        )}
      </DropdownContent>
    </Dropdown>
  );
}
