import {
  inferSessionIdentity,
  openTraceStore,
  resolveDatabasePath,
} from "@trace/core";
import { runTraceCli } from "./trace.ts";

type ClaudeStopHookInput = {
  session_id?: string;
  transcript_path?: string;
  hook_event_name?: string;
  // Claude sets this true when the Stop hook is firing again as a consequence
  // of a prior block. Honoured to block at most once per drift, never looping.
  stop_hook_active?: boolean;
  cwd?: string;
};

// Shape of the `trace state check` verdict this runner consumes. Only the
// prose-pass fields are load-bearing here.
type StateCheckVerdict = {
  needsProsePass?: boolean;
  reason?: string;
};

// Main-agent `Stop` hook: when the live session is explicitly bound to a task
// whose state.md prose has drifted from its docs, block the turn once with a
// reason pointing at `trace state reflect`. An unbound session — or one whose
// state is already reconciled — ends the turn normally (exit 0, no output).
//
// Binding is resolved STRICTLY: only the session's explicit `taskId` counts,
// never `resolveActiveTask`'s most-recent-task fallback, so an ordinary chat
// turn in an unbound session is never asked to reflect on someone else's task.
export function runClaudeStopHook(
  rawInput: string,
  env: Record<string, string | undefined> = process.env,
): { exitCode: number; stdout: string; stderr: string } {
  const input = JSON.parse(rawInput) as ClaudeStopHookInput;

  if (input.hook_event_name && input.hook_event_name !== "Stop") {
    return failure(
      `Expected Stop hook input, received ${input.hook_event_name}`,
    );
  }

  // Already continuing from a prior block — do not block again. Blocking once
  // per drift is the contract; a second block here would loop the agent.
  if (input.stop_hook_active) return ok();

  // Resolve the live session id from the payload (with env as fallback), the
  // same override contract the SessionStart runner uses.
  const identity = inferSessionIdentity(env, {
    tool: "claude",
    id: input.session_id,
    transcriptPath: input.transcript_path,
  });
  const sessionId = identity.id;
  if (!sessionId) return ok();

  const databasePath = resolveDatabasePath(env);
  const store = openTraceStore(databasePath);
  let task: { slug: string } | null = null;
  try {
    task = resolveStrictlyBoundTask(store, sessionId);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error), 1);
  } finally {
    store.close();
  }

  // Unbound session (or bound to an archived/missing task) — nothing to check.
  if (!task) return ok();

  // Hand the resolved binding to `trace state check`, which recomputes the
  // verdict. It re-resolves the session from env, so surface this session's id
  // to it (the payload may carry an id absent from the ambient env).
  const childEnv = {
    ...env,
    CLAUDE_CODE_SESSION_ID: sessionId,
    ...(identity.transcriptPath
      ? { CLAUDE_TRANSCRIPT_PATH: identity.transcriptPath }
      : {}),
  };
  const result = runTraceCli(["state", "check", task.slug], childEnv);
  if (result.exitCode !== 0) {
    return failure(
      result.stderr.trim() || `state check exited ${result.exitCode}`,
      1,
    );
  }

  const verdict = JSON.parse(result.stdout) as StateCheckVerdict;
  if (verdict.needsProsePass) {
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({
        decision: "block",
        reason: verdict.reason ?? "state.md is out of date — reflect on it.",
      })}\n`,
      stderr: "",
    };
  }

  return ok();
}

// Strict explicit-binding resolver: returns the unarchived task the session is
// directly assigned to, or null. Deliberately does NOT fall back to the
// project's most-recent task the way `resolveActiveTask` does.
function resolveStrictlyBoundTask(
  store: ReturnType<typeof openTraceStore>,
  sessionId: string,
): { slug: string } | null {
  const taskId = store.getSession(sessionId)?.taskId;
  if (!taskId) return null;
  const task = store.getTask(taskId);
  if (!task || task.archivedAt) return null;
  return task;
}

function ok(): { exitCode: number; stdout: string; stderr: string } {
  return { exitCode: 0, stdout: "", stderr: "" };
}

function failure(
  message: string,
  exitCode = 2,
): { exitCode: number; stdout: string; stderr: string } {
  return { exitCode, stdout: "", stderr: `${message}\n` };
}
