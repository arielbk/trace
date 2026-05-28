#!/usr/bin/env node
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

  const result = runTraceCli(
    ["session", "register", "--id", input.session_id, "--transcript", input.transcript_path, "--tool", "claude"],
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
