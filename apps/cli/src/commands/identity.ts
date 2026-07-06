import {
  inferSessionIdentity,
  type SessionIdentity,
  type SessionIdentityOverrides,
} from "@trace/core";
import { resolveCursorSession } from "@trace/cursor-reader";
import type { Env } from "./seam.ts";

type CliIdentityOverrides = Omit<
  SessionIdentityOverrides,
  "cwd" | "resolveCursorSession"
>;

// The CLI's composition root for session identity. Cursor (unlike claude and
// codex) exposes no env var, so locating a live Cursor session needs the
// cwd→session resolver from @trace/cursor-reader; wiring it here — once —
// means no command re-decides whether Cursor is reachable, and none can
// silently forget the resolver. The claude SessionStart hook runner is the one
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
  });
}
