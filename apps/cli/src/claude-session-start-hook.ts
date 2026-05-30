#!/usr/bin/env node
import { inferSessionIdentity } from "@trace/core";
import { readFileSync } from "node:fs";
import { runTraceCli } from "./trace.ts";

type ClaudeSessionStartHookInput = {
  session_id?: string;
  transcript_path?: string;
  hook_event_name?: string;
};

const isDirectRun = import.meta.url === `file://${process.argv[1]}`;

export function runClaudeSessionStartHook(
  rawInput: string,
  env: Record<string, string | undefined> = process.env,
): { exitCode: number; stdout: string; stderr: string } {
  const input = JSON.parse(rawInput) as ClaudeSessionStartHookInput;

  if (input.hook_event_name && input.hook_event_name !== "SessionStart") {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `Expected SessionStart hook input, received ${input.hook_event_name}\n`,
    };
  }

  if (!input.session_id) {
    return { exitCode: 2, stdout: "", stderr: "SessionStart input requires session_id\n" };
  }

  if (!input.transcript_path) {
    return { exitCode: 2, stdout: "", stderr: "SessionStart input requires transcript_path\n" };
  }

  // The "which tool / id / transcript path is the live session" contract lives
  // in @trace/core; the hook treats its stdin payload as overrides (a Claude
  // SessionStart is always the claude tool) and reads back the resolved values.
  const identity = inferSessionIdentity(env, {
    tool: "claude",
    id: input.session_id,
    transcriptPath: input.transcript_path,
  });

  const result = runTraceCli(
    [
      "session",
      "register",
      "--id",
      identity.id ?? input.session_id,
      "--transcript",
      identity.transcriptPath ?? input.transcript_path,
      "--tool",
      identity.tool,
    ],
    env,
  );

  return result.exitCode === 0 ? { ...result, stdout: "" } : result;
}

if (isDirectRun) {
  const result = runClaudeSessionStartHook(readFileSync(0, "utf8"));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
