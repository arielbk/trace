import type { Session, TaskStore } from "./types.ts";

export type SessionLocator = {
  findSession(id: string | undefined): Session | null;
};

export function createStoreSessionLocator(
  store: Pick<TaskStore, "getSession">,
): SessionLocator {
  return {
    findSession(id) {
      const normalized = normalizeSessionId(id);
      return normalized ? store.getSession(normalized) : null;
    },
  };
}

export function resolveTraceParentSession(
  env: Record<string, string | undefined>,
  locator: SessionLocator,
): Session | null {
  return locator.findSession(env.TRACE_PARENT_SESSION);
}

function normalizeSessionId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
