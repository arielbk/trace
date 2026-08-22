import {
  readGitWorkContext,
  type RegisterSessionInput,
  type Session,
  type Task,
} from "@trace/core";
import { inferCliSessionIdentity } from "./identity.ts";
import { reconcileStateFooter } from "./task-operations.ts";
import type { Env, Store } from "./seam.ts";

/**
 * The bind seam: everything Trace does when a Session starts working on a Task.
 *
 * Three commands bind — `trace skill work-on-task`, `trace skill re-enter`, and
 * `trace session assign` — and before this module each spelled the ritual out.
 * It owns three things those seams used to re-derive: the fixed order of the
 * steps, the question "is there a live session to bind at all?", and the rule
 * that a session's Git work context is re-read at every touchpoint rather than
 * frozen at bind.
 *
 * Resolving *which project* the work is in stays with the seam: `work-on-task`
 * has to resolve it before it can create the task, and the resolution notice
 * it reports ("created new project" vs "linked to existing") only reads true
 * on that first call.
 */

export type BindRequest = {
  store: Store;
  databasePath: string;
  /** The task to bind to — already resolved (or created) by the seam. */
  task: Task;
  /** Where the session is working right now; the Git context is read from it. */
  cwd: string;
};

/**
 * Bind a session to a task: reconcile the task's State Document footer,
 * register the session, and assign it with the Git work context read from
 * `cwd`.
 *
 * The reconcile runs *before* the session joins the task, and that order is
 * load-bearing: footer bookkeeping is a write to state.md, and state
 * provenance credits the newest session that had started when the file was
 * last written. Reconciling first means a bind can never be credited with
 * prose it did not write. The reconcile is write-if-changed, so a seam that
 * needed the footer earlier — `re-enter` materializes it before building the
 * manifest, so state.md is listed there — may reconcile again at no cost.
 */
export function bindSessionToTask(
  request: BindRequest,
  registration: RegisterSessionInput,
): Session {
  const { store, databasePath, task, cwd } = request;

  reconcileStateFooter(store, databasePath, task);

  const session = store.registerSession(registration);
  return store.assignSession(session.id, task.id, readGitWorkContext(cwd));
}

/**
 * The live session to bind, or null when there is none.
 *
 * Both fields are required: an identity that cannot name a transcript is not
 * something Trace can register, so a command holding one must behave as if it
 * ran outside a session — a human at a bare terminal reading a manifest has
 * nothing to bind — rather than binding a half-identified one.
 */
export function liveSession(
  env: Env,
  cwd: string,
): RegisterSessionInput | null {
  const identity = inferCliSessionIdentity(env, cwd);
  if (identity.id === undefined || identity.transcriptPath === undefined) {
    return null;
  }
  return {
    id: identity.id,
    transcriptPath: identity.transcriptPath,
    tool: identity.tool,
  };
}

/**
 * Re-read where a bound session's work is landing and record it.
 *
 * The counterpart to the sampling `bindSessionToTask` does: a session that
 * binds on one branch and then cuts another has moved, and `lastWorkedOn`
 * exists to tell the next agent where to pick up. A wrong branch there is
 * worse than an absent one — it sends a fresh session to a branch that does
 * not contain the work.
 *
 * Cheap enough to run per turn: one `readGitWorkContext`, and the store writes
 * nothing when the context has not moved.
 */
export function recordSessionWorkContext(
  store: Store,
  sessionId: string,
  cwd: string,
): Session | null {
  return store.recordSessionWorkContext(sessionId, readGitWorkContext(cwd));
}
