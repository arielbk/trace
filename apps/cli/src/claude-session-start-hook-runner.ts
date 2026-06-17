import {
  inferSessionIdentity,
} from "@trace/core";
import { appendFileSync, mkdirSync } from "node:fs";
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
  // The project directory Claude is running in. Used to key the active-task
  // lookup to the same project root tasks are stored under.
  cwd?: string;
};

type ActiveTaskResult =
  | { kind: "none" }
  | { kind: "bound" | "re-enter"; task: { title: string; slug: string } };

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
    return {
      exitCode: 2,
      stdout: "",
      stderr: "SessionStart input requires session_id\n",
    };
  }

  if (!input.transcript_path) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: "SessionStart input requires transcript_path\n",
    };
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
    return result;
  }

  // Registration is the hook's primary, must-not-fail responsibility; the nudge
  // is purely additive. Any failure resolving it degrades to the prior
  // behaviour — a registered session with no injected context — and leaves the
  // same breadcrumb a failed registration would, never changing the exit code.
  const sessionId = identity.id ?? input.session_id;
  let nudge = "";
  try {
    nudge = resolveSessionNudge(env, sessionId, input.cwd);
  } catch (error) {
    recordHookFailure(env, {
      sessionId: input.session_id,
      source: input.source,
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  return { ...result, stdout: nudge };
}

// Ask the active-task query what this session is bound to and turn its answer
// into the single line Claude sees as SessionStart context: a quiet
// confirmation when bound, otherwise an offer that points Claude at the trace
// skill. The project root is keyed to the payload's cwd — the directory Claude
// is in — so it matches where the project's tasks are stored.
function resolveSessionNudge(
  env: Record<string, string | undefined>,
  sessionId: string,
  cwd: string | undefined,
): string {
  const argv = cwd
    ? ["session", "active-task", "--id", sessionId, "--project", cwd]
    : ["session", "active-task", "--id", sessionId];
  const result = runTraceCli(argv, env);

  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() || `active-task exited ${result.exitCode}`,
    );
  }

  const active = JSON.parse(result.stdout) as ActiveTaskResult;

  if (active.kind === "bound") {
    return `✓ Trace tracking: ${active.task.title}\n`;
  }
  if (active.kind === "re-enter") {
    return `Trace: no task is bound to this session yet — the most recent task in this project is "${active.task.title}". If this session continues that work, offer to re-enter it.\n`;
  }
  return "Trace: no task is bound to this session and this project has none yet. If the user is doing real project work, offer to start tracking it.\n";
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
