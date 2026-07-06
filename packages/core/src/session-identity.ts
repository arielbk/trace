import type { SessionTool } from "./types.ts";
import { syntheticLocator } from "./transcript-locator.ts";
import {
  getSessionLocator,
  sessionLocatorsByPrecedence,
  type LocateContext,
  type SessionLocation,
} from "./tool-locator.ts";

export type SessionIdentityOverrides = {
  tool?: SessionTool;
  id?: string;
  transcriptPath?: string;
  // The directory the bind ran from — used to resolve a Cursor session, which
  // (unlike claude/codex) exposes no env var trace can read. Paired with
  // `resolveCursorSession`; without both, cursor resolution is skipped.
  cwd?: string;
  // Maps a cwd → the current Cursor session: the focused GUI composer or the
  // newest cursor-agent (CLI) chat (null when the cwd has neither). Injected so
  // @trace/core stays free of filesystem reads; the CLI supplies one backed by
  // `resolveCursorSession` from `@trace/cursor-reader`.
  resolveCursorSession?: (
    cwd: string,
  ) => { id: string; transcriptPath: string | null } | null;
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
  const ctx: LocateContext = {
    env,
    cwd: overrides.cwd,
    resolveCursorSession: overrides.resolveCursorSession,
  };
  const location = locateSession(ctx, overrides.tool);
  const tool = overrides.tool ?? location?.tool ?? "claude";
  const id = present(overrides.id) ?? location?.id;
  const transcriptPath =
    present(overrides.transcriptPath) ??
    (id === undefined
      ? undefined
      : (location?.nativeTranscriptPath ??
        nativeTranscriptPathForExplicitId(ctx, tool, id) ??
        syntheticLocator(tool, id)));

  return { tool, id, transcriptPath };
}

function locateSession(
  ctx: LocateContext,
  forcedTool: SessionTool | undefined,
): SessionLocation | null {
  if (forcedTool) {
    return getSessionLocator(forcedTool).locate(ctx);
  }

  for (const locator of sessionLocatorsByPrecedence) {
    const location = locator.locate(ctx);
    if (location) {
      return location;
    }
  }

  return null;
}

function nativeTranscriptPathForExplicitId(
  ctx: LocateContext,
  tool: SessionTool,
  id: string,
): string | undefined {
  const env =
    tool === "codex"
      ? { ...ctx.env, CODEX_THREAD_ID: id }
      : tool === "claude"
        ? { ...ctx.env, CLAUDE_CODE_SESSION_ID: id }
        : undefined;

  if (!env) {
    return undefined;
  }

  return getSessionLocator(tool).locate({ ...ctx, env })?.nativeTranscriptPath;
}

// Trims a candidate value and collapses blank to undefined, so `??` chains
// skip over it the same way they skip an unset variable.
function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
