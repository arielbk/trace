import type { SessionTool } from "./types.ts";

export type SessionIdentityOverrides = {
  tool?: SessionTool;
  id?: string;
  transcriptPath?: string;
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
  const tool = overrides.tool ?? inferTool(env);
  const id = present(overrides.id) ?? inferId(tool, env);
  const transcriptPath =
    present(overrides.transcriptPath) ??
    (id === undefined ? undefined : inferTranscriptPath(id, tool, env));

  return { tool, id, transcriptPath };
}

// Trims a candidate value and collapses blank to undefined, so `??` chains
// skip over it the same way they skip an unset variable.
function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function inferTool(env: Record<string, string | undefined>): SessionTool {
  if (present(env.CODEX_THREAD_ID)) {
    return "codex";
  }

  return "claude";
}

function inferId(
  tool: SessionTool,
  env: Record<string, string | undefined>,
): string | undefined {
  if (tool === "codex") {
    return present(env.CODEX_THREAD_ID);
  }

  // Claude Code exports the live session id as CLAUDE_CODE_SESSION_ID; the
  // legacy CLAUDE_SESSION_ID / session_id are accepted for hook-stdin callers
  // and older integrations.
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
