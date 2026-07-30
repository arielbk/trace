import {
  inferSessionIdentity,
  type SessionIdentity,
  type SessionIdentityOverrides,
} from "@trace/core";
import {
  resolveCursorSession,
  resolveCursorSessionById,
} from "@trace/cursor-reader";
import { resolveCopilotSession } from "../copilot-session.ts";
import type { Env } from "./seam.ts";

type CliIdentityOverrides = Omit<
  SessionIdentityOverrides,
  | "cwd"
  | "resolveCursorSession"
  | "resolveCursorSessionById"
  | "resolveCopilotSession"
>;

// The CLI's composition root for session identity. Cursor session ids come
// from CURSOR_CONVERSATION_ID, but resolving an id's flavor (GUI composer vs
// cursor-agent chat) — and locating a session when the env var is absent —
// needs the resolvers from @trace/cursor-reader; wiring them here — once —
// means no command re-decides whether Cursor is reachable, and none can
// silently forget a resolver. The claude SessionStart hook runner is the one
// deliberate exception: it forces `tool: "claude"`, so the cursor locator is
// unreachable there by construction.
export function inferCliSessionIdentity(
  env: Env,
  cwd: string,
  overrides: CliIdentityOverrides = {},
): SessionIdentity {
  return inferSessionIdentity(env, {
    ...overrides,
    cwd,
    resolveCursorSession: (dir) => resolveCursorSession(dir),
    resolveCursorSessionById: (id) => resolveCursorSessionById(id, { cwd }),
    resolveCopilotSession: () => resolveCopilotSession(env),
  });
}
