import { readFileSync } from "node:fs";
import { isSyntheticLocator } from "./transcript-locator.ts";
import type { SessionTool } from "./types.ts";

export type TranscriptExportStatus =
  | "included"
  | "another-machine"
  | "file-gone"
  | "no-transcript-file";

export type TranscriptFormat =
  | "claude-jsonl"
  | "codex-jsonl"
  | "copilot-jsonl"
  | "cursor-agent-jsonl";

export type ExportTranscriptInput = {
  transcriptPath: string;
  sessionMachineId: string;
  localMachineId: string;
};

export type ExportedTranscript =
  | {
      status: "included";
      bytes: Uint8Array;
      format: TranscriptFormat;
      extension: ".jsonl" | ".json";
    }
  | {
      status: Exclude<TranscriptExportStatus, "included">;
    };

export function exportFileTranscript(
  input: ExportTranscriptInput,
  format: TranscriptFormat,
  tool: SessionTool,
): ExportedTranscript {
  if (isSyntheticLocator(input.transcriptPath, tool)) {
    return { status: "no-transcript-file" };
  }
  try {
    return {
      status: "included",
      bytes: new Uint8Array(readFileSync(input.transcriptPath)),
      format,
      extension: ".jsonl",
    };
  } catch {
    if (input.sessionMachineId !== input.localMachineId) {
      return { status: "another-machine" };
    }
    return { status: "file-gone" };
  }
}
