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

/**
 * Whether this machine can actually read the session's transcript.
 *
 * A session row travels between machines; its transcript does not. The locator
 * that came down with the row names a file (or a Cursor conversation) on
 * whichever machine ran the session, so anything reporting a session to a user
 * has to be able to tell "there is nothing to show" from "this is not the
 * machine that has it".
 */
export function hasReadableTranscript(input: {
  transcriptPath: string;
  tool: SessionTool;
}): boolean {
  try {
    return getTranscriptAdapter(input.tool).hasTranscript(input.transcriptPath);
  } catch {
    return false;
  }
}

export function tailTranscriptMessages(
  input: TranscriptTailInput,
): TranscriptMessage[] {
  return getTranscriptAdapter(input.tool).tail({
    transcript: input.transcript,
    limit: input.limit,
  });
}
