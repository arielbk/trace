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
export function inferSessionIdentity(
  env: Record<string, string | undefined>,
  overrides: SessionIdentityOverrides = {},
): SessionIdentity {
  const tool = overrides.tool ?? inferTool(env);
  const id = overrides.id ?? inferId(tool, env);
  const transcriptPath =
    overrides.transcriptPath ??
    (id === undefined ? undefined : inferTranscriptPath(id, tool, env));

  return { tool, id, transcriptPath };
}

function inferTool(env: Record<string, string | undefined>): SessionTool {
  if (env.CODEX_THREAD_ID) {
    return "codex";
  }

  return "claude";
}

function inferId(
  tool: SessionTool,
  env: Record<string, string | undefined>,
): string | undefined {
  if (tool === "codex") {
    return env.CODEX_THREAD_ID;
  }

  // Claude Code exports the live session id as CLAUDE_CODE_SESSION_ID; the
  // legacy CLAUDE_SESSION_ID / session_id are accepted for hook-stdin callers
  // and older integrations.
  return env.CLAUDE_CODE_SESSION_ID ?? env.CLAUDE_SESSION_ID ?? env.session_id;
}

function inferTranscriptPath(
  id: string,
  tool: SessionTool,
  env: Record<string, string | undefined>,
): string {
  if (tool === "claude" && env.CLAUDE_TRANSCRIPT_PATH) {
    return env.CLAUDE_TRANSCRIPT_PATH;
  }

  if (tool === "codex" && env.CODEX_TRANSCRIPT_PATH) {
    return env.CODEX_TRANSCRIPT_PATH;
  }

  return `${tool}:${id}`;
}
