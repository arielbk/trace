#!/usr/bin/env node
import { inferSessionIdentity } from "@trace/core";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveDbPath } from "./db-path.ts";
import { runTraceCli } from "./trace.ts";

type ClaudeSessionStartHookInput = {
  session_id?: string;
  transcript_path?: string;
  hook_event_name?: string;
  // startup | resume | clear | compact — registration is source-agnostic, but
  // the field is part of the contract so the matcher must admit every value.
  source?: string;
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

  let result: { exitCode: number; stdout: string; stderr: string };
  try {
    result = runTraceCli(
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
  } catch (error) {
    // A thrown error (e.g. the store failing to open) escapes runTraceCli; treat
    // it as a registration failure rather than letting it crash the hook unseen.
    const reason = error instanceof Error ? error.message : String(error);
    result = { exitCode: 1, stdout: "", stderr: `${reason}\n` };
  }

  if (result.exitCode !== 0) {
    // Claude Code swallows SessionStart hook stderr/exit codes, so a failed
    // registration would otherwise vanish. Leave an inspectable breadcrumb so
    // gaps are noticed when they happen, not weeks later.
    recordHookFailure(env, {
      sessionId: input.session_id,
      source: input.source,
      reason: result.stderr.trim() || `exit code ${result.exitCode}`,
    });
  }

  return result.exitCode === 0 ? { ...result, stdout: "" } : result;
}

function recordHookFailure(
  env: Record<string, string | undefined>,
  failure: { sessionId: string; source?: string | undefined; reason: string },
): void {
  try {
    const logDir = dirname(resolveDbPath(env));
    mkdirSync(logDir, { recursive: true });
    const entry = `${new Date().toISOString()}\tSessionStart\tsession=${failure.sessionId}\tsource=${failure.source ?? "unknown"}\treason=${failure.reason.replace(/\s+/g, " ")}\n`;
    appendFileSync(`${logDir}/hook-errors.log`, entry);
  } catch {
    // Logging is best-effort; never let it mask or replace the original failure.
  }
}

if (isDirectRun) {
  const result = runClaudeSessionStartHook(readFileSync(0, "utf8"));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
