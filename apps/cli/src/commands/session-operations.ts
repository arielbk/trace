import {
  getTranscriptAdapter,
  scanClaudeCodeSessions,
  scanCodexSessions,
} from "@trace/core";
import {
  parseClaudeScanArgs,
  parseCodexScanArgs,
  parseSessionActiveTaskArgs,
  parseSessionRegisterArgs,
  parseSessionSetParentArgs,
  parseSessionTailLimit,
} from "./parsers.ts";
import { formatActiveTask, formatSessionSummary } from "./formatters.ts";
import {
  attempt,
  failure,
  resolveProjectRoot,
  success,
  withStore,
  type CommandResult,
  type Env,
} from "./seam.ts";

export type CommandContext = { env: Env; cwd: string; stdin: string };

export function sessionRegisterOperation(
  rawArgs: string[],
  ctx: CommandContext,
): CommandResult {
  const parsedAttempt = attempt(() => parseSessionRegisterArgs(rawArgs));
  if (!parsedAttempt.ok) return parsedAttempt.result;
  const parsed = parsedAttempt.value;

  return withStore(ctx.env, (store) => {
    const session = store.registerSession(parsed);
    return success(`${session.id}\n`);
  });
}

export function sessionAssignOperation(
  rawArgs: string[],
  ctx: CommandContext,
): CommandResult {
  const sessionId = rawArgs[0];
  const taskId = rawArgs[1];
  if (!sessionId) return failure("Session id is required");
  if (!taskId) return failure("Task id is required");

  return withStore(ctx.env, (store) => {
    const session = store.assignSession(sessionId, taskId);
    return success(formatSessionSummary(session));
  });
}

export function sessionSetParentOperation(
  rawArgs: string[],
  ctx: CommandContext,
): CommandResult {
  const parsedAttempt = attempt(() => parseSessionSetParentArgs(rawArgs));
  if (!parsedAttempt.ok) return parsedAttempt.result;
  const parsed = parsedAttempt.value;

  return withStore(ctx.env, (store) => {
    const session = store.setSessionParent(parsed);
    return success(formatSessionSummary(session));
  });
}

export function sessionActiveTaskOperation(
  rawArgs: string[],
  ctx: CommandContext,
): CommandResult {
  const parsedAttempt = attempt(() => parseSessionActiveTaskArgs(rawArgs));
  if (!parsedAttempt.ok) return parsedAttempt.result;
  const parsed = parsedAttempt.value;

  const projectRootAttempt = resolveProjectRoot(parsed.project, ctx.cwd);
  if (!projectRootAttempt.ok) return projectRootAttempt.result;
  const projectRoot = projectRootAttempt.value;

  return withStore(ctx.env, (store) => {
    const activeTask = store.resolveActiveTask(parsed.id, projectRoot);
    return success(`${JSON.stringify(formatActiveTask(activeTask))}\n`);
  });
}

export function sessionListOperation(
  rawArgs: string[],
  ctx: CommandContext,
): CommandResult {
  if (rawArgs[0] !== "--unassigned") {
    return failure("Usage: trace session list --unassigned");
  }

  return withStore(ctx.env, (store) => {
    return success(store.listUnassignedSessions().map(formatSessionSummary).join(""));
  });
}

export function sessionTailOperation(
  rawArgs: string[],
  ctx: CommandContext,
): CommandResult {
  const sessionId = rawArgs[0];
  if (!sessionId) return failure("Session id is required");

  const limitAttempt = attempt(() => parseSessionTailLimit(rawArgs.slice(1)));
  if (!limitAttempt.ok) return limitAttempt.result;
  const limit = limitAttempt.value;

  return withStore(ctx.env, (store) => {
    const session = store.getSession(sessionId);
    if (!session) return failure(`Session not found: ${sessionId}`, 1);
    return success(
      getTranscriptAdapter(session.tool)
        .readTail({ transcriptPath: session.transcriptPath, limit })
        .map((message) => `${message.role}: ${message.text}\n`)
        .join(""),
    );
  });
}

export function sessionScanOperation(
  rawArgs: string[],
  ctx: CommandContext,
): CommandResult {
  if (rawArgs[0] === "--codex") {
    const codexHomeAttempt = attempt(() =>
      parseCodexScanArgs(rawArgs.slice(1), ctx.env),
    );
    if (!codexHomeAttempt.ok) return codexHomeAttempt.result;
    const codexHome = codexHomeAttempt.value;

    return withStore(ctx.env, (store) => {
      const sessions = scanCodexSessions(codexHome).map((session) =>
        store.registerSession({
          id: session.id,
          transcriptPath: session.transcriptPath,
          tool: session.tool,
          model: session.model,
          tokenTotals: session.tokenTotals,
        }),
      );
      return success(sessions.map(formatSessionSummary).join(""));
    });
  }

  if (rawArgs[0] === "--claude") {
    const projectsRootAttempt = attempt(() =>
      parseClaudeScanArgs(rawArgs.slice(1), ctx.env),
    );
    if (!projectsRootAttempt.ok) return projectsRootAttempt.result;
    const projectsRoot = projectsRootAttempt.value;

    return withStore(ctx.env, (store) => {
      const sessions = scanClaudeCodeSessions(projectsRoot).map((session) =>
        store.registerSession({
          id: session.id,
          transcriptPath: session.transcriptPath,
          tool: session.tool,
          model: session.model,
          tokenTotals: session.tokenTotals,
        }),
      );
      return success(sessions.map(formatSessionSummary).join(""));
    });
  }

  return failure("Usage: trace session scan --codex | --claude");
}
