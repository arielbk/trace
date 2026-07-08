// Cursor agent (CLI) transcripts. Both the `cursor-agent` CLI and current
// Cursor GUI builds mirror each chat as clean JSONL at
// `~/.cursor/projects/<project-key>/agent-transcripts/<chatId>/<chatId>.jsonl`,
// where <chatId> is the same id the GUI store calls a composerId. This module
// is the pull-time path for chats that never touch (or can't be resolved
// through) the GUI's state.vscdb — the cursor-agent CLI case.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import type { CursorMessage } from "./types.ts";

/** Default `~/.cursor/projects` root holding per-project agent transcripts. */
export function defaultProjectsRoot(): string {
  return join(homedir(), ".cursor", "projects");
}

export type AgentTranscriptOptions = {
  projectsRoot?: string;
};

export type AgentChat = {
  chatId: string;
  transcriptPath: string;
  /** Transcript mtime, epoch ms — the freshness signal for resolution. */
  lastUpdatedAt: number;
};

/**
 * Cursor's directory key for a project path: path segments joined with `-`,
 * everything outside [A-Za-z0-9-] stripped (observed: `/Users/x/.claude/y`
 * → `Users-x-claude-y`, `/Users/x/Projects/side/trace-v2`
 * → `Users-x-Projects-side-trace-v2`).
 */
export function cursorProjectKey(repoPath: string): string {
  return repoPath
    .split(sep)
    .filter(Boolean)
    .join("-")
    .replace(/[^A-Za-z0-9-]/g, "");
}

/**
 * The most recently written agent chat for a repo, or null when the repo has
 * no transcripts. "Most recent" is transcript mtime: when the resolving agent
 * runs a shell command, its own prompt has already been appended, so the live
 * chat is reliably the freshest file.
 */
export function resolveLatestAgentChat(
  repoPath: string,
  opts?: AgentTranscriptOptions,
): AgentChat | null {
  const projectsRoot = opts?.projectsRoot ?? defaultProjectsRoot();
  const transcriptsDir = join(
    projectsRoot,
    cursorProjectKey(repoPath),
    "agent-transcripts",
  );
  if (!existsSync(transcriptsDir)) return null;

  let latest: AgentChat | null = null;
  for (const dirent of readdirSync(transcriptsDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const chatId = dirent.name;
    const transcriptPath = join(transcriptsDir, chatId, `${chatId}.jsonl`);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(transcriptPath).mtimeMs;
    } catch {
      continue; // chat dir without a transcript file
    }
    if (!latest || mtimeMs > latest.lastUpdatedAt) {
      latest = { chatId, transcriptPath, lastUpdatedAt: mtimeMs };
    }
  }
  return latest;
}

/**
 * Locate a chat's transcript JSONL by id: the cwd's project dir first (the
 * overwhelmingly common case), then every other project dir — a chat can be
 * looked up from a different directory than the one it started in. Null when
 * no project holds a transcript for the id.
 */
export function findAgentTranscript(
  chatId: string,
  opts?: AgentTranscriptOptions & { cwd?: string },
): string | null {
  const projectsRoot = opts?.projectsRoot ?? defaultProjectsRoot();
  if (!existsSync(projectsRoot)) return null;

  const keys = opts?.cwd ? [cursorProjectKey(opts.cwd)] : [];
  for (const dirent of readdirSync(projectsRoot, { withFileTypes: true })) {
    if (dirent.isDirectory() && !keys.includes(dirent.name)) {
      keys.push(dirent.name);
    }
  }
  for (const key of keys) {
    const transcriptPath = join(
      projectsRoot,
      key,
      "agent-transcripts",
      chatId,
      `${chatId}.jsonl`,
    );
    if (existsSync(transcriptPath)) return transcriptPath;
  }
  return null;
}

type TranscriptLine = {
  role?: unknown;
  message?: { content?: unknown };
};

type ContentBlock = {
  type?: unknown;
  text?: unknown;
  name?: unknown;
};

/**
 * Parse an agent transcript's JSONL into neutral `CursorMessage`s. The line
 * shape is `{role, message: {content: [{type: "text"|"tool_use", ...}]}}` —
 * near-identical to Claude Code's. Unreadable files and malformed lines yield
 * nothing rather than throwing (fail missing, not wrong).
 */
export function readAgentTranscriptMessages(
  transcriptPath: string,
): CursorMessage[] {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return [];
  }

  const messages: CursorMessage[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: TranscriptLine;
    try {
      parsed = JSON.parse(line) as TranscriptLine;
    } catch {
      continue;
    }
    const role = parsed.role;
    if (role !== "user" && role !== "assistant") continue;
    const content = parsed.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content as ContentBlock[]) {
      if (block.type === "text") {
        const raw = typeof block.text === "string" ? block.text : "";
        const text = role === "user" ? unwrapUserText(raw) : raw;
        if (text.trim().length === 0) continue;
        messages.push(
          role === "user" ? { kind: "user", text } : { kind: "assistant", text },
        );
      } else if (block.type === "tool_use") {
        const name = typeof block.name === "string" ? block.name : "tool";
        messages.push({ kind: "tool", name });
      }
    }
  }
  return messages;
}

/**
 * cursor-agent wraps the actual prompt in metadata tags —
 * `<timestamp>…</timestamp>\n<user_query>\n…\n</user_query>` — which would
 * otherwise leak into session names and re-entry tails. Unwrap to the query
 * text when present; always drop timestamp tags.
 */
function unwrapUserText(text: string): string {
  const query = /<user_query>([\s\S]*?)<\/user_query>/.exec(text);
  if (query?.[1] !== undefined) return query[1].trim();
  return text.replace(/<timestamp>[\s\S]*?<\/timestamp>/g, "").trim();
}
