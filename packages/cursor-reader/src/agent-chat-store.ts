// cursor-agent's private per-chat store, the CLI counterpart to the GUI's
// state.vscdb: `~/.cursor/chats/<md5(cwd)>/<chatId>/` holds `meta.json`
// (cwd, createdAtMs) and a `store.db` SQLite of message blobs. The JSONL
// mirror carries no model and no project root, but both live here — assistant
// blobs embed `providerOptions.cursor.modelName`, some as clean JSON and some
// inside binary wrappers, so extraction is a byte-level scan rather than a
// parse. Everything degrades to null on any miss (fail missing, not wrong).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { openReadOnly } from "./storage.ts";

/** Default `~/.cursor/chats` root holding per-chat CLI stores. */
export function defaultChatsRoot(): string {
  return join(homedir(), ".cursor", "chats");
}

export type AgentChatStoreOptions = {
  chatsRoot?: string;
};

export type AgentChatEnrichment = {
  model: string | null;
  cwd: string | null;
  createdAt: number | null; // epoch ms (meta.json createdAtMs)
};

const EMPTY: AgentChatEnrichment = { model: null, cwd: null, createdAt: null };

/**
 * Enrich a cursor-agent chat from its private store. The hash segment of the
 * chat dir is md5 of the chat's cwd — unknowable from the chatId alone — so the
 * (small, one-per-project) hash dirs are scanned for one containing the chat.
 */
export function readAgentChatEnrichment(
  chatId: string,
  opts?: AgentChatStoreOptions,
): AgentChatEnrichment {
  const chatDir = findChatDir(chatId, opts?.chatsRoot ?? defaultChatsRoot());
  if (!chatDir) return EMPTY;
  const meta = readMeta(join(chatDir, "meta.json"));
  return {
    model: readModelName(join(chatDir, "store.db")),
    cwd: meta.cwd,
    createdAt: meta.createdAt,
  };
}

function findChatDir(chatId: string, chatsRoot: string): string | null {
  let hashes: string[];
  try {
    hashes = readdirSync(chatsRoot);
  } catch {
    return null;
  }
  for (const hash of hashes) {
    const dir = join(chatsRoot, hash, chatId);
    if (existsSync(dir)) return dir;
  }
  return null;
}

function readMeta(metaPath: string): {
  cwd: string | null;
  createdAt: number | null;
} {
  try {
    const parsed = JSON.parse(readFileSync(metaPath, "utf8")) as {
      cwd?: unknown;
      createdAtMs?: unknown;
    };
    return {
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : null,
      createdAt:
        typeof parsed.createdAtMs === "number" ? parsed.createdAtMs : null,
    };
  } catch {
    return { cwd: null, createdAt: null };
  }
}

/**
 * The chat's model, from the last `"modelName":"…"` across the store's message
 * blobs in insertion order — so a mid-chat model switch reports the newest.
 * Latin1 decoding preserves raw bytes, letting one regex cover both the clean
 * JSON blobs and the JSON embedded in binary wrappers. Chats observed in the
 * wild can carry a store.db with no `blobs` table at all; that (and any other
 * read failure) yields null.
 */
function readModelName(storeDbPath: string): string | null {
  const db = openReadOnly(storeDbPath);
  if (!db) return null;
  try {
    const rows = db
      .prepare("SELECT data FROM blobs ORDER BY rowid")
      .all() as Array<{ data?: string | Uint8Array }>;
    let model: string | null = null;
    for (const row of rows) {
      if (row.data == null) continue;
      const text =
        typeof row.data === "string"
          ? row.data
          : Buffer.from(row.data).toString("latin1");
      for (const match of text.matchAll(/"modelName":"([^"]+)"/g)) {
        model = match[1] ?? model;
      }
    }
    return model;
  } catch {
    return null;
  } finally {
    db.close();
  }
}
