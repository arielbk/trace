import { openTraceStore, resolveDatabasePath } from "@trace/core";
import { inferCliSessionIdentity } from "./commands/identity.ts";
import { runTraceCli } from "./trace.ts";

type CopilotHookInput = {
  hookEventName?: string;
  sessionId?: string;
  timestamp?: number;
  cwd?: string;
};

type StateCheckVerdict = {
  needsProsePass?: boolean;
  reason?: string;
};

// Copilot command hooks use camelCase fields. Session identity still goes
// through the CLI composition root so the lock-file locator can replace the
// synthetic locator with the session's real events.jsonl when it is live.
export function runCopilotSessionStartHook(
  rawInput: string,
  env: Record<string, string | undefined> = process.env,
): { exitCode: number; stdout: string; stderr: string } {
  const input = JSON.parse(rawInput) as CopilotHookInput;
  const invalid = validate(input, "sessionStart");
  if (invalid) return invalid;

  const identity = inferCliSessionIdentity(env, input.cwd ?? process.cwd(), {
    tool: "copilot",
    id: input.sessionId,
  });
  if (!identity.id || !identity.transcriptPath) {
    return failure("sessionStart input requires sessionId");
  }

  return runTraceCli(
    [
      "session",
      "register",
      "--id",
      identity.id,
      "--transcript",
      identity.transcriptPath,
      "--tool",
      "copilot",
    ],
    env,
  );
}

// `agentStop` is Copilot's counterpart to Claude Code's Stop hook. It uses
// the same strict explicit-session binding rule: an unbound session must never
// inherit the project's most-recent task.
export function runCopilotAgentStopHook(
  rawInput: string,
  env: Record<string, string | undefined> = process.env,
): { exitCode: number; stdout: string; stderr: string } {
  const input = JSON.parse(rawInput) as CopilotHookInput;
  const invalid = validate(input, "agentStop");
  if (invalid) return invalid;
  const sessionId = input.sessionId?.trim();
  if (!sessionId) return ok();

  const store = openTraceStore(resolveDatabasePath(env));
  let task: { slug: string } | null = null;
  try {
    const taskId = store.getSession(sessionId)?.taskId;
    const candidate = taskId ? store.getTask(taskId) : null;
    task = candidate && !candidate.archivedAt ? candidate : null;
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error), 1);
  } finally {
    store.close();
  }
  if (!task) return ok();

  // `state check`'s explicit-binding guard currently reads the resolved live
  // identity from environment. Copilot deliberately has no session-id env var,
  // so provide the hook payload's id through the guard's established Claude
  // compatibility channel; the store lookup above remains the authoritative
  // Copilot binding and only the shared command's gate consumes this value.
  const result = runTraceCli(["state", "check", task.slug], {
    ...env,
    CLAUDE_CODE_SESSION_ID: sessionId,
  });
  if (result.exitCode !== 0) {
    return failure(result.stderr.trim() || `state check exited ${result.exitCode}`, 1);
  }
  const verdict = JSON.parse(result.stdout) as StateCheckVerdict;
  return verdict.needsProsePass
    ? {
        exitCode: 0,
        stdout: `${JSON.stringify({ decision: "block", reason: verdict.reason ?? "state.md is out of date — reflect on it." })}\n`,
        stderr: "",
      }
    : ok();
}

// Copilot supplies subagentStop before its transcript linkage has been
// established. Accept the lifecycle event now; the discovery slice owns any
// scanner or live child registration once empirical evidence provides a path.
export function runCopilotSubagentStopHook(
  rawInput: string,
): { exitCode: number; stdout: string; stderr: string } {
  const input = JSON.parse(rawInput) as CopilotHookInput;
  return validate(input, "subagentStop") ?? ok();
}

export function isCopilotHookPayload(rawInput: string): boolean {
  try {
    return "sessionId" in (JSON.parse(rawInput) as object);
  } catch {
    return false;
  }
}

function validate(
  input: CopilotHookInput,
  event: "sessionStart" | "agentStop" | "subagentStop",
): { exitCode: number; stdout: string; stderr: string } | null {
  if (input.hookEventName && input.hookEventName !== event) {
    return failure(`Expected ${event} hook input, received ${input.hookEventName}`);
  }
  if (!input.sessionId?.trim()) return failure(`${event} input requires sessionId`);
  return null;
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
