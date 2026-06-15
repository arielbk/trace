import type { SessionTool } from "./types.ts";

export type SessionIdentityOverrides = {
  tool?: SessionTool;
  id?: string;
  transcriptPath?: string;
  // The directory the bind ran from — used to resolve a Cursor session, which
  // (unlike claude/codex) exposes no env var trace can read. Paired with
  // `resolveCursorComposer`; without both, cursor resolution is skipped.
  cwd?: string;
  // Maps a cwd → the focused Cursor composerId (or null when the cwd is not a
  // Cursor workspace). Injected so @trace/core stays free of filesystem reads;
  // the CLI supplies one backed by `resolveFocusedComposer` from
  // `@trace/cursor-reader`.
  resolveCursorComposer?: (cwd: string) => string | null;
};

export type SessionIdentity = {
  tool: SessionTool;
  id: string | undefined;
  transcriptPath: string | undefined;
};

// Owns the cross-tool "which env var is the live session" contract: given a
// process env (and optional caller overrides), decide the tool, the session id,
// and the transcript path. Each piece is independently overridable so callers
// can supply explicit flags while still inferring the rest.
//
// Blank values (empty or whitespace-only, as a hook exporting an unset var
// produces) are treated as absent everywhere — otherwise a blank id survives
// callers' "is there a session?" checks and only fails at registration, after
// they have already mutated state. Surviving values are trimmed so the
// identity matches what registration would persist.
export function inferSessionIdentity(
  env: Record<string, string | undefined>,
  overrides: SessionIdentityOverrides = {},
): SessionIdentity {
  // Cursor exposes no env var, so its composerId is resolved from the cwd. Only
  // attempt it when the caller forces `tool: "cursor"` or when no claude/codex
  // session env is present (a live IDE/CLI session always wins, and the resolver
  // touches the Cursor SQLite store — skip it when something else already owns
  // the session).
  const cursorComposerId =
    overrides.tool === "cursor" ||
    (overrides.tool === undefined && !hasEnvSession(env))
      ? resolveCursorComposer(overrides)
      : undefined;

  const tool = overrides.tool ?? inferTool(env, cursorComposerId);
  const id = present(overrides.id) ?? inferId(tool, env, cursorComposerId);
  const transcriptPath =
    present(overrides.transcriptPath) ??
    (id === undefined ? undefined : inferTranscriptPath(id, tool, env));

  return { tool, id, transcriptPath };
}

// True when the env already names a live claude or codex session — the case
// where cursor cwd resolution must not run.
function hasEnvSession(env: Record<string, string | undefined>): boolean {
  return present(env.CODEX_THREAD_ID) !== undefined || claudeId(env) !== undefined;
}

// Runs the injected resolver against the cwd, collapsing a missing cwd/resolver
// or a blank composerId to undefined.
function resolveCursorComposer(
  overrides: SessionIdentityOverrides,
): string | undefined {
  const cwd = present(overrides.cwd);
  if (!cwd || !overrides.resolveCursorComposer) {
    return undefined;
  }
  return present(overrides.resolveCursorComposer(cwd) ?? undefined);
}

// Trims a candidate value and collapses blank to undefined, so `??` chains
// skip over it the same way they skip an unset variable.
function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function inferTool(
  env: Record<string, string | undefined>,
  cursorComposerId: string | undefined,
): SessionTool {
  if (present(env.CODEX_THREAD_ID)) {
    return "codex";
  }

  // A resolved Cursor composer only reaches here when no claude/codex env was
  // present (see `inferSessionIdentity`), so it cannot shadow a live session.
  if (cursorComposerId) {
    return "cursor";
  }

  return "claude";
}

function inferId(
  tool: SessionTool,
  env: Record<string, string | undefined>,
  cursorComposerId: string | undefined,
): string | undefined {
  if (tool === "codex") {
    return present(env.CODEX_THREAD_ID);
  }

  if (tool === "cursor") {
    return cursorComposerId;
  }

  return claudeId(env);
}

// Claude Code exports the live session id as CLAUDE_CODE_SESSION_ID; the legacy
// CLAUDE_SESSION_ID / session_id are accepted for hook-stdin callers and older
// integrations.
function claudeId(
  env: Record<string, string | undefined>,
): string | undefined {
  return (
    present(env.CLAUDE_CODE_SESSION_ID) ??
    present(env.CLAUDE_SESSION_ID) ??
    present(env.session_id)
  );
}

function inferTranscriptPath(
  id: string,
  tool: SessionTool,
  env: Record<string, string | undefined>,
): string {
  const claudePath = present(env.CLAUDE_TRANSCRIPT_PATH);
  if (tool === "claude" && claudePath) {
    return claudePath;
  }

  const codexPath = present(env.CODEX_TRANSCRIPT_PATH);
  if (tool === "codex" && codexPath) {
    return codexPath;
  }

  return `${tool}:${id}`;
}
