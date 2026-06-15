import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getDatabaseSync } from "./node-sqlite.ts";

// Test helper: writes a tiny real Cursor storage tree (two `.vscdb` SQLite
// files + a workspace.json) under `root`, mirroring the verified on-disk shape.
// Exercises the real node:sqlite read path in tests rather than stubbing it.

export type FixtureBubble = {
  bubbleId: string;
  /** 1 = user, 2 = assistant */
  type: 1 | 2;
  /** Header grouping hints (e.g. { hasText: true } / { hasThinking: true }). */
  grouping?: Record<string, unknown>;
  /** 30 = thinking, 15 = tool call. Omit for plain user/assistant text. */
  capabilityType?: number;
  text?: string;
  thinking?: { text: string; signature?: string };
  toolFormerData?: {
    name?: string;
    status?: string;
    toolCallId?: string;
    params?: unknown;
    result?: unknown;
  };
  tokenCount?: { inputTokens?: number; outputTokens?: number };
};

export type FixtureComposer = {
  composerId: string;
  name?: string | null;
  model?: string | null;
  createdAt?: number | null;
  lastUpdatedAt?: number | null;
  usageData?: { inputTokens?: number; outputTokens?: number } | null;
  contextTokensUsed?: number;
  contextTokenLimit?: number;
  bubbles?: FixtureBubble[];
};

export type FixtureSpec = {
  workspaceHash: string;
  /** Filesystem path the workspace folder resolves to (becomes file:// URL). */
  folder: string;
  /** Composer ids in `composer.composerData.lastFocusedComposerIds` (most recent first). */
  lastFocusedComposerIds?: string[];
  composers: FixtureComposer[];
};

function writeVscdb(
  path: string,
  table: "ItemTable" | "cursorDiskKV",
  rows: Array<[string, string]>,
): void {
  const DatabaseSync = getDatabaseSync();
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE ${table} (key TEXT PRIMARY KEY, value BLOB)`);
  const insert = db.prepare(`INSERT INTO ${table} (key, value) VALUES (?, ?)`);
  for (const [key, value] of rows) insert.run(key, value);
  db.close();
}

/** Build the storage tree and return the resolved global db path for reference. */
export function buildCursorFixture(root: string, spec: FixtureSpec): void {
  const wsDir = join(root, "workspaceStorage", spec.workspaceHash);
  const globalDir = join(root, "globalStorage");
  mkdirSync(wsDir, { recursive: true });
  mkdirSync(globalDir, { recursive: true });

  writeFileSync(
    join(wsDir, "workspace.json"),
    JSON.stringify({ folder: pathToFileURL(spec.folder).href }),
  );

  const focused =
    spec.lastFocusedComposerIds ??
    (spec.composers[0] ? [spec.composers[0].composerId] : []);

  writeVscdb(join(wsDir, "state.vscdb"), "ItemTable", [
    [
      "composer.composerData",
      JSON.stringify({
        lastFocusedComposerIds: focused,
        selectedComposerIds: focused,
        hasMigratedMultipleComposers: true,
      }),
    ],
  ]);

  const globalRows: Array<[string, string]> = [];
  for (const composer of spec.composers) {
    const bubbles = composer.bubbles ?? [];
    globalRows.push([
      `composerData:${composer.composerId}`,
      JSON.stringify({
        _v: 16,
        composerId: composer.composerId,
        name: composer.name ?? null,
        modelConfig: { modelName: composer.model ?? null },
        createdAt: composer.createdAt ?? null,
        lastUpdatedAt: composer.lastUpdatedAt ?? null,
        usageData: composer.usageData ?? undefined,
        contextTokensUsed: composer.contextTokensUsed,
        contextTokenLimit: composer.contextTokenLimit,
        fullConversationHeadersOnly: bubbles.map((b) => ({
          bubbleId: b.bubbleId,
          type: b.type,
          grouping: b.grouping ?? {},
        })),
      }),
    ]);
    for (const b of bubbles) {
      globalRows.push([
        `bubbleId:${composer.composerId}:${b.bubbleId}`,
        JSON.stringify({
          _v: 3,
          bubbleId: b.bubbleId,
          type: b.type,
          capabilityType: b.capabilityType,
          text: b.text,
          thinking: b.thinking,
          toolFormerData: b.toolFormerData,
          tokenCount: b.tokenCount,
        }),
      ]);
    }
  }
  writeVscdb(join(globalDir, "state.vscdb"), "cursorDiskKV", globalRows);
}
