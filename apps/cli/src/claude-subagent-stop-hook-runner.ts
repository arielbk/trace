import {
  discoverClaudeCodeSubagentSessions,
  openTraceStore,
} from "@trace/core";
import { dirname } from "node:path";
import { resolveDbPath } from "./db-path.ts";

type ClaudeSubagentStopHookInput = {
  session_id?: string;
  transcript_path?: string;
  hook_event_name?: string;
  subagent_transcript_path?: string;
};

export function runClaudeSubagentStopHook(
  rawInput: string,
  env: Record<string, string | undefined> = process.env,
): { exitCode: number; stdout: string; stderr: string } {
  const input = JSON.parse(rawInput) as ClaudeSubagentStopHookInput;

  if (input.hook_event_name && input.hook_event_name !== "SubagentStop") {
    return failure(
      `Expected SubagentStop hook input, received ${input.hook_event_name}`,
    );
  }

  const parentSessionId = input.session_id?.trim();
  if (!parentSessionId) {
    return failure("SubagentStop input requires session_id");
  }

  const databasePath = resolveDbPath(env);
  const store = openTraceStore(databasePath);
  try {
    discoverClaudeCodeSubagentSessions({
      store,
      parentSessionId,
      subagentsDir: subagentsDirFromInput(input),
    });
    return { exitCode: 0, stdout: "", stderr: "" };
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error), 1);
  } finally {
    store.close();
  }
}

function subagentsDirFromInput(
  input: ClaudeSubagentStopHookInput,
): string | undefined {
  const transcriptPath = input.subagent_transcript_path?.trim();
  return transcriptPath ? dirname(transcriptPath) : undefined;
}

function failure(
  message: string,
  exitCode = 2,
): { exitCode: number; stdout: string; stderr: string } {
  return { exitCode, stdout: "", stderr: `${message}\n` };
}
