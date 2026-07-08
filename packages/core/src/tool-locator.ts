import type { SessionTool } from "./types.ts";

export type LocateContext = {
  env: Record<string, string | undefined>;
  cwd?: string | undefined;
  // Maps a cwd → the current Cursor session: `id` is the composer/chat id and
  // `transcriptPath` is the agent-transcript JSONL for CLI-flavor chats (null
  // for GUI composers, which read through state.vscdb via a `cursor:<id>`
  // locator instead).
  resolveCursorSession?: (
    cwd: string,
  ) => { id: string; transcriptPath: string | null } | null;
  // Resolves the flavor of a Cursor session already identified by id (from
  // CURSOR_CONVERSATION_ID) — same return contract as resolveCursorSession.
  resolveCursorSessionById?: (
    id: string,
  ) => { id: string; transcriptPath: string | null } | null;
};

export type SessionLocation = {
  tool: SessionTool;
  id: string;
  nativeTranscriptPath: string | undefined;
};

export type ToolSessionLocator = {
  readonly tool: SessionTool;
  locate(ctx: LocateContext): SessionLocation | null;
};

const codexSessionLocator: ToolSessionLocator = {
  tool: "codex",
  locate(ctx) {
    const id = present(ctx.env.CODEX_THREAD_ID);
    if (!id) {
      return null;
    }

    return {
      tool: "codex",
      id,
      nativeTranscriptPath: present(ctx.env.CODEX_TRANSCRIPT_PATH),
    };
  },
};

const claudeSessionLocator: ToolSessionLocator = {
  tool: "claude",
  locate(ctx) {
    const id =
      present(ctx.env.CLAUDE_CODE_SESSION_ID) ??
      present(ctx.env.CLAUDE_SESSION_ID) ??
      present(ctx.env.session_id);
    if (!id) {
      return null;
    }

    return {
      tool: "claude",
      id,
      nativeTranscriptPath: present(ctx.env.CLAUDE_TRANSCRIPT_PATH),
    };
  },
};

const cursorSessionLocator: ToolSessionLocator = {
  tool: "cursor",
  locate(ctx) {
    // Both the Cursor GUI's integrated terminal and cursor-agent CLI shells
    // carry CURSOR_CONVERSATION_ID — the deterministic per-session identity,
    // the analogue of CLAUDE_CODE_SESSION_ID / CODEX_THREAD_ID. It names the
    // exact session issuing the command, so it always beats cwd guessing,
    // which can pick a fresher sibling session in the same repo.
    const envId = present(ctx.env.CURSOR_CONVERSATION_ID);
    if (envId) {
      const resolved = ctx.resolveCursorSessionById?.(envId) ?? null;
      return {
        tool: "cursor",
        id: envId,
        nativeTranscriptPath: present(resolved?.transcriptPath ?? undefined),
      };
    }

    const cwd = present(ctx.cwd);
    if (!cwd || !ctx.resolveCursorSession) {
      return null;
    }

    const resolved = ctx.resolveCursorSession(cwd);
    const id = present(resolved?.id);
    if (!resolved || !id) {
      return null;
    }

    return {
      tool: "cursor",
      id,
      nativeTranscriptPath: present(resolved.transcriptPath ?? undefined),
    };
  },
};

export const sessionLocatorsByPrecedence = [
  codexSessionLocator,
  claudeSessionLocator,
  cursorSessionLocator,
] as const satisfies readonly ToolSessionLocator[];

// Partial because the tool axis (`SessionTool`) can carry tools whose locator
// has not landed yet. `getSessionLocator` throws for an unregistered tool
// rather than returning undefined, preserving the non-null contract callers
// rely on.
const locatorsByTool: Partial<Record<SessionTool, ToolSessionLocator>> = {
  codex: codexSessionLocator,
  claude: claudeSessionLocator,
  cursor: cursorSessionLocator,
};

export function getSessionLocator(tool: SessionTool): ToolSessionLocator {
  const locator = locatorsByTool[tool];
  if (!locator) {
    throw new Error(`No session locator registered for tool "${tool}"`);
  }
  return locator;
}

// Trims a candidate value and collapses blank to undefined, so `??` chains
// skip over it the same way they skip an unset variable.
function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
