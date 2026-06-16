import type { SessionTool } from "./types.ts";

export type LocateContext = {
  env: Record<string, string | undefined>;
  cwd?: string | undefined;
  resolveCursorComposer?: (cwd: string) => string | null;
};

export type SessionLocation = {
  tool: SessionTool;
  id: string;
  nativeTranscriptPath: string | undefined;
};

export type SessionLocator = {
  readonly tool: SessionTool;
  locate(ctx: LocateContext): SessionLocation | null;
};

const codexSessionLocator: SessionLocator = {
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

const claudeSessionLocator: SessionLocator = {
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

const cursorSessionLocator: SessionLocator = {
  tool: "cursor",
  locate(ctx) {
    const cwd = present(ctx.cwd);
    if (!cwd || !ctx.resolveCursorComposer) {
      return null;
    }

    const id = present(ctx.resolveCursorComposer(cwd) ?? undefined);
    if (!id) {
      return null;
    }

    return {
      tool: "cursor",
      id,
      nativeTranscriptPath: undefined,
    };
  },
};

export const sessionLocatorsByPrecedence = [
  codexSessionLocator,
  claudeSessionLocator,
  cursorSessionLocator,
] as const satisfies readonly SessionLocator[];

// Partial because the tool axis (`SessionTool`) can carry tools whose locator
// has not landed yet. `getSessionLocator` throws for an unregistered tool
// rather than returning undefined, preserving the non-null contract callers
// rely on.
const locatorsByTool: Partial<Record<SessionTool, SessionLocator>> = {
  codex: codexSessionLocator,
  claude: claudeSessionLocator,
  cursor: cursorSessionLocator,
};

export function getSessionLocator(tool: SessionTool): SessionLocator {
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
