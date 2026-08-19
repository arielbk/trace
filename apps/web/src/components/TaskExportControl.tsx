import { useId, useState } from "react";
import { downloadTaskExport } from "../lib/api.ts";
import { cn } from "../lib/utils.ts";
import { DownloadIcon } from "./icons.tsx";

/** Matches the CLI's `--include-transcripts` stderr warning. */
export const TRANSCRIPT_EXPORT_WARNING =
  "Warning: transcripts are copied verbatim and unredacted. They may contain secrets, absolute paths, and machine identifiers.";

/**
 * Downloads a task export zip from the board. Transcripts stay off unless the
 * checkbox is checked; the warning is always visible so the opt-in is informed
 * consent rather than a surprise after the fact.
 */
export function TaskExportControl({
  taskRef,
  className,
}: {
  taskRef: string;
  className?: string;
}) {
  const warningId = useId();
  const [includeTranscripts, setIncludeTranscripts] = useState(false);

  return (
    <div className={cn("contents", className)}>
      <div className="inline-flex items-center gap-2 flex-wrap">
        <button
          type="button"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border bg-surface text-text-muted text-xs font-semibold cursor-pointer transition-colors hover:text-accent hover:border-border-strong"
          aria-label="Export task"
          onClick={() => {
            void downloadTaskExport(taskRef, { includeTranscripts });
          }}
        >
          <DownloadIcon />
          Export
        </button>
        <label className="inline-flex items-center gap-chip-gap text-text-muted text-crumb font-medium cursor-pointer select-none">
          <input
            type="checkbox"
            checked={includeTranscripts}
            onChange={(event) => setIncludeTranscripts(event.target.checked)}
            aria-describedby={warningId}
          />
          Include transcripts
        </label>
      </div>
      <p
        id={warningId}
        className="order-last basis-full m-0 max-w-row-description text-crumb text-text-muted leading-relaxed"
      >
        {TRANSCRIPT_EXPORT_WARNING}
      </p>
    </div>
  );
}
