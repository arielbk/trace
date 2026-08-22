import type { Session, StateAuthor } from "./types.ts";

export type { StateAuthor };

/**
 * Who wrote the `state.md` prose a reader is looking at: the newest top-level
 * session that had already started when the file was last written.
 *
 * Attribution looks *backwards* from the state file's timestamp rather than
 * taking the newest session outright. The session reading the board — or the
 * one that just re-entered the task — is newer than the prose it is reading,
 * and picking the latest session would credit it with words it did not write.
 *
 * In-process subagents are skipped: they run inside another session's turn and
 * never author the living state file. Spawned children (a Ralph iteration, say)
 * are top-level runs that do, so they stay eligible.
 */
export function resolveStateAuthor(
  sessions: readonly Session[],
  stateUpdatedAt: string | undefined,
): StateAuthor | undefined {
  if (!stateUpdatedAt) return undefined;

  const author = sessions
    .filter(
      (session) =>
        session.origin !== "subagent" && session.createdAt <= stateUpdatedAt,
    )
    .reduce<Session | undefined>(
      (newest, session) =>
        !newest ||
        session.createdAt > newest.createdAt ||
        (session.createdAt === newest.createdAt && session.id > newest.id)
          ? session
          : newest,
      undefined,
    );
  if (!author) return undefined;

  return {
    tool: author.tool,
    // Model stays optional/absent rather than null, matching the Session-derived
    // metadata convention elsewhere in the manifest and timeline contracts.
    ...(author.model ? { model: author.model } : {}),
  };
}
