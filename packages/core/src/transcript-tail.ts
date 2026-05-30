import { getTranscriptAdapter } from "./transcript-adapter.ts";
import type { TranscriptMessage } from "./transcript-messages.ts";
import type { SessionTool } from "./types.ts";

export type { TranscriptMessage } from "./transcript-messages.ts";

export type TranscriptTailInput = {
  transcript: string;
  tool: SessionTool;
  limit?: number | undefined;
};

export type ReadTranscriptTailInput = {
  transcriptPath: string;
  tool: SessionTool;
  limit?: number | undefined;
};

export function readTranscriptTail(
  input: ReadTranscriptTailInput,
): TranscriptMessage[] {
  return getTranscriptAdapter(input.tool).readTail({
    transcriptPath: input.transcriptPath,
    limit: input.limit,
  });
}

export function tailTranscriptMessages(
  input: TranscriptTailInput,
): TranscriptMessage[] {
  return getTranscriptAdapter(input.tool).tail({
    transcript: input.transcript,
    limit: input.limit,
  });
}
