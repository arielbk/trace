import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  cursorProjectKey,
  defaultProjectsRoot,
  readAgentTranscriptMessages,
  readComposerSubagentInfo,
} from "@trace/cursor-reader";
import {
  composerIdFromLocator,
  cursorLocatorFlavor,
} from "./transcript-locator.ts";
import type { Session, TaskStore } from "./types.ts";

// Cursor in-process subagents (the composer's Task tool) mirror each child as
// JSONL under the parent chat's transcript dir — the same directory-adjacency
// convention as Claude Code, minus the `agent-` filename prefix:
//
//   ~/.cursor/projects/<key>/agent-transcripts/<chatId>/subagents/<id>.jsonl
//
// The subagent type comes from the child's own GUI composer record
// (`subagentInfo.subagentTypeName`); on machines without a GUI store, the
// parent transcript's Task tool_use carries `subagent_type` + `prompt` but no
// tool ids, so the fallback correlates a child by matching its first user
// query against the recorded prompts. Model, title, and token totals are not
// stamped here — the store's read-time refresh resolves them through the
// cursor transcript adapter.

export type DiscoverCursorSubagentSessionsInput = {
  store: TaskStore;
  parentSessionId: string;
  subagentsDir?: string;
  projectsRoot?: string;
  // Child chat ids already linked to this parent, skipped wholesale — a
  // read-time caller pays the composer/prompt lookups only for new children.
  skipChatIds?: ReadonlySet<string>;
};

export function discoverCursorSubagentSessions(
  input: DiscoverCursorSubagentSessionsInput,
): Session[] {
  const parent = input.store.getSession(input.parentSessionId);
  if (!parent) {
    throw new Error(`Parent session not found: ${input.parentSessionId}`);
  }
  if (parent.tool !== "cursor") {
    throw new Error(`Session ${parent.id} is not a cursor session`);
  }

  const subagentsDir =
    input.subagentsDir ??
    resolveCursorSubagentsDir(input.store, parent, input.projectsRoot);
  if (!subagentsDir || !existsSync(subagentsDir)) {
    return [];
  }

  const spawnPrompts = lazyTaskSpawnPrompts(dirname(subagentsDir));

  return listCursorSubagentChatIds(subagentsDir)
    .filter((chatId) => !input.skipChatIds?.has(chatId))
    .map((chatId) => {
      const transcriptPath = join(subagentsDir, `${chatId}.jsonl`);
      const subagentType =
        readComposerSubagentInfo(chatId)?.subagentType ??
        promptMatchedType(spawnPrompts(), transcriptPath);

      const registered = input.store.getSession(chatId)
        ? input.store.setSessionParent({
            id: chatId,
            parentSessionId: parent.id,
            origin: "subagent",
            subagentType,
          })
        : input.store.registerSession({
            id: chatId,
            transcriptPath,
            tool: "cursor",
            parentSessionId: parent.id,
            origin: "subagent",
            subagentType,
            agentId: chatId,
          });

      return parent.taskId
        ? input.store.assignSession(registered.id, parent.taskId)
        : registered;
    });
}

/**
 * The parent's `subagents` mirror dir. An agent-transcript parent carries the
 * real path, so the dir sits next to it; a composer-flavor parent has only a
 * synthetic locator, so the mirror is derived from the bound task's project
 * root (Cursor keys the mirror tree by project path).
 */
export function resolveCursorSubagentsDir(
  store: TaskStore,
  parent: Session,
  projectsRoot?: string,
): string | null {
  if (cursorLocatorFlavor(parent.transcriptPath) === "agent-transcript") {
    return join(dirname(parent.transcriptPath), "subagents");
  }

  const projectRoot = parent.taskId
    ? (store.getTask(parent.taskId)?.projectRoot ?? null)
    : null;
  if (!projectRoot) {
    return null;
  }

  return join(
    projectsRoot ?? defaultProjectsRoot(),
    cursorProjectKey(projectRoot),
    "agent-transcripts",
    composerIdFromLocator(parent.transcriptPath),
    "subagents",
  );
}

/** The child chat ids mirrored under a `subagents` dir, in stable order. */
export function listCursorSubagentChatIds(subagentsDir: string): string[] {
  return readdirSync(subagentsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => entry.name.slice(0, -".jsonl".length))
    .sort((left, right) => left.localeCompare(right));
}

type TaskSpawnPrompt = { prompt: string; subagentType: string | null };

/**
 * Read the parent transcript's Task tool_use records once, on first need —
 * only children with no composer record fall back to prompt matching.
 */
function lazyTaskSpawnPrompts(
  parentChatDir: string,
): () => TaskSpawnPrompt[] {
  let spawns: TaskSpawnPrompt[] | null = null;
  return () => {
    if (spawns) return spawns;
    // The chat dir is named by the chat id, and the mirror transcript inside
    // it repeats that name: <chatId>/<chatId>.jsonl.
    const parentTranscriptPath = join(
      parentChatDir,
      `${basename(parentChatDir)}.jsonl`,
    );
    spawns = readTaskSpawnPrompts(parentTranscriptPath);
    return spawns;
  };
}

function readTaskSpawnPrompts(parentTranscriptPath: string): TaskSpawnPrompt[] {
  if (!existsSync(parentTranscriptPath)) {
    return [];
  }

  const spawns: TaskSpawnPrompt[] = [];
  for (const line of readFileSync(parentTranscriptPath, "utf8").split("\n")) {
    if (!line.includes('"Task"')) continue;
    let parsed: {
      message?: { content?: unknown };
    };
    try {
      parsed = JSON.parse(line) as { message?: { content?: unknown } };
    } catch {
      continue;
    }
    const content = parsed.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type !== "tool_use" || block.name !== "Task") continue;
      const blockInput = block.input as
        | { prompt?: unknown; subagent_type?: unknown }
        | undefined;
      if (typeof blockInput?.prompt !== "string") continue;
      spawns.push({
        prompt: blockInput.prompt.trim(),
        subagentType:
          typeof blockInput.subagent_type === "string"
            ? blockInput.subagent_type
            : null,
      });
    }
  }
  return spawns;
}

function promptMatchedType(
  spawns: TaskSpawnPrompt[],
  childTranscriptPath: string,
): string | null {
  if (spawns.length === 0) return null;
  const firstUser = readAgentTranscriptMessages(childTranscriptPath).find(
    (message) => message.kind === "user",
  );
  if (!firstUser || firstUser.kind !== "user") return null;
  const query = firstUser.text.trim();
  return spawns.find((spawn) => spawn.prompt === query)?.subagentType ?? null;
}
