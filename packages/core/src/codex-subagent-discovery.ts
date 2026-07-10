import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  parseCodexTranscriptFile,
  resolveCodexTranscriptPathById,
  type CodexSubagentSpawn,
} from "./codex-adapter.ts";
import { isSyntheticLocator, syntheticLocator } from "./transcript-locator.ts";
import type { Session, TaskStore, TokenTotals } from "./types.ts";

// Codex in-process subagents (the spawn_agent collaboration tool) are
// recovered from the parent rollout's spawn records — either a
// `collab_agent_spawn_end` event or, on Codex Desktop 0.142+, a `spawn_agent`
// function_call/output pair (the adapter normalizes both into
// `subagentSpawns`: parent id, child thread id, role, nickname). The
// child is its own rollout file under the Codex home, date-partitioned by its
// *own* start time, so it is resolved by thread id rather than by directory
// adjacency. A child whose rollout hasn't been found yet is registered under a
// synthetic `codex:<id>` locator; the store upgrades it to the real path when
// a later scan finds one.

export type DiscoverCodexSubagentSessionsInput = {
  store: TaskStore;
  parentSessionId: string;
  codexHome?: string;
};

export function discoverCodexSubagentSessions(
  input: DiscoverCodexSubagentSessionsInput,
): Session[] {
  const parent = input.store.getSession(input.parentSessionId);
  if (!parent) {
    throw new Error(`Parent session not found: ${input.parentSessionId}`);
  }
  if (parent.tool !== "codex") {
    throw new Error(`Session ${parent.id} is not a codex session`);
  }

  const codexHome = input.codexHome ?? join(homedir(), ".codex");
  const parentTranscriptPath = resolveParentTranscriptPath(
    parent,
    codexHome,
  );
  if (!parentTranscriptPath) {
    return [];
  }

  const parsed = parseCodexTranscriptFile(parentTranscriptPath, {
    expectedThreadId: parent.id,
  });

  return parsed.subagentSpawns.map((spawn) =>
    registerCodexSubagentSpawn(input.store, parent, spawn, codexHome),
  );
}

function resolveParentTranscriptPath(
  parent: Session,
  codexHome: string,
): string | null {
  if (
    !isSyntheticLocator(parent.transcriptPath, "codex") &&
    existsSync(parent.transcriptPath)
  ) {
    return parent.transcriptPath;
  }

  return resolveCodexTranscriptPathById(codexHome, parent.id);
}

/**
 * Register (or enrich) one spawned child from a parent-side spawn record. Also
 * the store's read-time entry point: its refresh pass already holds the
 * parent's parsed spawn records, so it links fresh ones directly instead of
 * re-parsing the parent through `discoverCodexSubagentSessions`.
 */
export function registerCodexSubagentSpawn(
  store: TaskStore,
  parent: Session,
  spawn: CodexSubagentSpawn,
  codexHome: string = join(homedir(), ".codex"),
): Session {
  const transcriptPath =
    resolveCodexTranscriptPathById(codexHome, spawn.threadId) ??
    syntheticLocator("codex", spawn.threadId);

  const registered = store.getSession(spawn.threadId)
    ? // A scan may have already registered the child as a root session;
      // register would preserve that row untouched, so enrich it instead.
      store.setSessionParent({
        id: spawn.threadId,
        parentSessionId: parent.id,
        origin: "subagent",
        subagentType: spawn.role,
      })
    : store.registerSession({
        id: spawn.threadId,
        transcriptPath,
        tool: "codex",
        parentSessionId: parent.id,
        origin: "subagent",
        subagentType: spawn.role,
        // The spawn nickname (on multi-agent v2, the parent-assigned task
        // name) is the only honest name the child has — its own rollout
        // forks the parent's turns, so a head-derived name would just
        // repeat the parent's first message.
        title: spawn.nickname,
        agentId: spawn.threadId,
        ...parseChildTranscript(transcriptPath),
      });

  return parent.taskId
    ? store.assignSession(registered.id, parent.taskId)
    : registered;
}

function parseChildTranscript(transcriptPath: string): {
  model?: string | null;
  tokenTotals?: Partial<TokenTotals>;
} {
  if (isSyntheticLocator(transcriptPath, "codex")) {
    return {};
  }

  try {
    const parsed = parseCodexTranscriptFile(transcriptPath);
    return { model: parsed.model, tokenTotals: parsed.tokenTotals };
  } catch {
    // A half-written live rollout parses on the next discovery run instead.
    return {};
  }
}
