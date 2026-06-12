#!/usr/bin/env node

// ../../packages/core/src/store.ts
import { randomUUID } from "crypto";
import { mkdirSync, statSync as statSync2 } from "fs";
import { basename as basename2, dirname as dirname2, resolve as resolve4 } from "path";

// ../../packages/core/src/migrations.ts
var migrationJournal = {
  entries: [
    {
      when: 1779991399241,
      tag: "0000_romantic_blizzard",
      breakpoints: true
    },
    {
      when: 17799997e5,
      tag: "0001_task_project_root",
      breakpoints: false
    },
    {
      when: 17800197e5,
      tag: "0002_session_model",
      breakpoints: false
    },
    {
      when: 17800997e5,
      tag: "0003_task_slug",
      breakpoints: true
    },
    {
      when: 17801197e5,
      tag: "0004_task_archive",
      breakpoints: false
    },
    {
      when: 17801397e5,
      tag: "0005_task_description",
      breakpoints: false
    }
  ]
};
var migrationSqlByTag = {
  "0000_romantic_blizzard": "CREATE TABLE `sessions` (\n	`id` text PRIMARY KEY NOT NULL,\n	`transcript_path` text NOT NULL,\n	`tool` text NOT NULL,\n	`task_id` text,\n	`created_at` text NOT NULL,\n	`input_tokens` integer DEFAULT 0 NOT NULL,\n	`output_tokens` integer DEFAULT 0 NOT NULL,\n	`cache_creation_input_tokens` integer DEFAULT 0 NOT NULL,\n	`cache_read_input_tokens` integer DEFAULT 0 NOT NULL,\n	`total_tokens` integer DEFAULT 0 NOT NULL,\n	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null\n);\n--> statement-breakpoint\nCREATE TABLE `task_docs` (\n	`task_id` text NOT NULL,\n	`path` text NOT NULL,\n	`created_at` text NOT NULL,\n	PRIMARY KEY(`task_id`, `path`),\n	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade\n);\n--> statement-breakpoint\nCREATE TABLE `tasks` (\n	`id` text PRIMARY KEY NOT NULL,\n	`title` text NOT NULL,\n	`created_at` text NOT NULL\n);\n",
  "0001_task_project_root": "ALTER TABLE `tasks` ADD `project_root` text DEFAULT '' NOT NULL;\n",
  "0002_session_model": "ALTER TABLE `sessions` ADD `model` text;\n",
  // The slug column lands nullable so existing rows survive the ALTER; the store
  // backfills slugs immediately after migrations run, then the unique index
  // guards uniqueness for backfilled and freshly created tasks alike.
  "0003_task_slug": "ALTER TABLE `tasks` ADD `slug` text;\n--> statement-breakpoint\nCREATE UNIQUE INDEX `tasks_slug_unique` ON `tasks` (`slug`);\n",
  "0004_task_archive": "ALTER TABLE `tasks` ADD `archived_at` text;\n",
  "0005_task_description": "ALTER TABLE `tasks` ADD `description` text;\n"
};

// ../../packages/core/src/node-sqlite.ts
import { createRequire } from "module";
var require2 = createRequire(import.meta.url);
var { DatabaseSync } = require2("node:sqlite");

// ../../packages/core/src/slug.ts
var MAX_SLUG_LENGTH = 60;
function slugify(title) {
  const transliterated = title.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  const kebab = transliterated.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return capLength(kebab);
}
var UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function looksLikeTaskId(value) {
  return UUID_PATTERN.test(value);
}
var SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;
function looksLikeSlug(value) {
  return SLUG_PATTERN.test(value) && !looksLikeTaskId(value);
}
function humanizeSlug(slug) {
  const spaced = slug.replace(/-/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
function generatePlaceholderSlug(id) {
  const shortId = id.split("-")[0] || id;
  return `task-${shortId}`;
}
function capLength(slug) {
  if (slug.length <= MAX_SLUG_LENGTH) {
    return slug;
  }
  const truncated = slug.slice(0, MAX_SLUG_LENGTH);
  const lastDash = truncated.lastIndexOf("-");
  const trimmed = lastDash > 0 ? truncated.slice(0, lastDash) : truncated;
  return trimmed.replace(/-+$/g, "");
}

// ../../packages/core/src/task-docs.ts
import { readdirSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
function resolveTaskDocsDir(databasePath, ref) {
  return join(dirname(resolve(databasePath)), "tasks", ref, "docs");
}
function listNativeTaskDocs(databasePath, taskId, slug) {
  return readNativeTaskDocs(databasePath, taskId, slug);
}
function readNativeTaskDocs(databasePath, taskId, ref) {
  const docsDir = resolveTaskDocsDir(databasePath, ref);
  try {
    return readdirSync(docsDir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => {
      const path = join(docsDir, entry.name);
      return {
        taskId,
        path,
        createdAt: statSync(path).mtime.toISOString()
      };
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
function mergeTaskDocs(registered, native) {
  const docsByPath = /* @__PURE__ */ new Map();
  for (const doc of registered) {
    docsByPath.set(doc.path, doc);
  }
  for (const doc of native) {
    if (!docsByPath.has(doc.path)) {
      docsByPath.set(doc.path, doc);
    }
  }
  return [...docsByPath.values()].sort((left, right) => {
    const byCreatedAt = left.createdAt.localeCompare(right.createdAt);
    if (byCreatedAt !== 0) return byCreatedAt;
    return left.path.localeCompare(right.path);
  });
}

// ../../packages/core/src/token-totals.ts
function emptyTokenTotals() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalTokens: 0
  };
}
function tokenTotalsFromUsage(usage2) {
  if (!usage2) {
    return emptyTokenTotals();
  }
  const inputTokens = usage2.input_tokens ?? usage2.inputTokens ?? 0;
  const outputTokens = usage2.output_tokens ?? usage2.outputTokens ?? 0;
  const cacheCreationInputTokens = usage2.cache_creation_input_tokens ?? usage2.cacheCreationInputTokens ?? 0;
  const cacheReadInputTokens = usage2.cache_read_input_tokens ?? usage2.cacheReadInputTokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    totalTokens: usage2.total_tokens ?? usage2.totalTokens ?? inputTokens + outputTokens + cacheCreationInputTokens + cacheReadInputTokens
  };
}
function addTokenTotals(left, right) {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheCreationInputTokens: left.cacheCreationInputTokens + right.cacheCreationInputTokens,
    cacheReadInputTokens: left.cacheReadInputTokens + right.cacheReadInputTokens,
    totalTokens: left.totalTokens + right.totalTokens
  };
}

// ../../packages/core/src/transcript-adapter.ts
import { readFileSync as readFileSync3 } from "fs";

// ../../packages/core/src/claude-code-adapter.ts
import { existsSync, readFileSync, readdirSync as readdirSync2 } from "fs";
import { join as join2, resolve as resolve2 } from "path";

// ../../packages/core/src/transcript-messages.ts
function collectTranscriptTail(transcript, limit, extract) {
  const normalizedLimit = normalizeLimit(limit);
  const messages = [];
  try {
    for (const line of transcript.split(/\r?\n/)) {
      if (line.trim().length === 0) {
        continue;
      }
      const event = JSON.parse(line);
      if (!isObject(event)) {
        continue;
      }
      const message = extract(event);
      if (message) {
        messages.push(message);
      }
    }
  } catch {
    return [];
  }
  return messages.slice(-normalizedLimit);
}
function collectTranscriptHead(transcript, limit, extract) {
  const normalizedLimit = normalizeLimit(limit);
  const messages = [];
  try {
    for (const line of transcript.split(/\r?\n/)) {
      if (line.trim().length === 0) {
        continue;
      }
      const event = JSON.parse(line);
      if (!isObject(event)) {
        continue;
      }
      const message = extract(event);
      if (message?.role === "user") {
        messages.push(message);
        if (messages.length >= normalizedLimit) {
          break;
        }
      }
    }
  } catch {
    return [];
  }
  return messages;
}
function normalizeLimit(limit) {
  return Number.isInteger(limit) && limit !== void 0 && limit > 0 ? limit : 8;
}
function normalizeRole(role) {
  if (role === "human" || role === "user") {
    return "user";
  }
  if (role === "assistant") {
    return "assistant";
  }
  return void 0;
}
function textFromContent(content) {
  if (typeof content === "string") {
    return normalizedText(content);
  }
  if (Array.isArray(content)) {
    const text = content.map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (isObject(part) && typeof part.text === "string") {
        return part.text;
      }
      return "";
    }).filter((part) => part.trim().length > 0).join("\n");
    return normalizedText(text);
  }
  if (isObject(content) && typeof content.text === "string") {
    return normalizedText(content.text);
  }
  return void 0;
}
function normalizedText(text) {
  const normalized = text.trim();
  return normalized.length > 0 ? normalized : void 0;
}
function isObject(value) {
  return typeof value === "object" && value !== null;
}

// ../../packages/core/src/claude-code-adapter.ts
function parseClaudeCodeTranscript(input) {
  let id;
  let model;
  let tokenTotals = emptyTokenTotals();
  for (const line of input.transcript.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    id ??= event.session_id ?? event.sessionId ?? event.message?.session_id ?? event.message?.sessionId;
    model ??= event.model ?? event.message?.model;
    tokenTotals = addTokenTotals(
      tokenTotals,
      tokenTotalsFromUsage(event.usage)
    );
    tokenTotals = addTokenTotals(
      tokenTotals,
      tokenTotalsFromUsage(event.message?.usage)
    );
  }
  if (!id) {
    throw new Error("Claude Code transcript does not include a session id");
  }
  return {
    id,
    transcriptPath: input.transcriptPath,
    tool: "claude",
    model: model ?? null,
    tokenTotals
  };
}
function parseClaudeCodeTranscriptFile(transcriptPath) {
  return parseClaudeCodeTranscript({
    transcript: readFileSync(transcriptPath, "utf8"),
    transcriptPath
  });
}
function scanClaudeCodeSessions(projectsRoot) {
  const sessions = [];
  for (const transcriptPath of findJsonlFiles(resolve2(projectsRoot))) {
    try {
      sessions.push(parseClaudeCodeTranscriptFile(transcriptPath));
    } catch {
    }
  }
  return sessions;
}
function findJsonlFiles(directoryPath) {
  if (!existsSync(directoryPath)) {
    return [];
  }
  return readdirSync2(directoryPath, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join2(directoryPath, entry.name);
    if (entry.isDirectory()) {
      return findJsonlFiles(fullPath);
    }
    return entry.isFile() && entry.name.endsWith(".jsonl") ? [fullPath] : [];
  }).sort((left, right) => left.localeCompare(right));
}
function tailClaudeCodeTranscript(input) {
  return collectTranscriptTail(
    input.transcript,
    input.limit,
    messageFromClaudeEvent
  );
}
function headClaudeCodeTranscript(input) {
  return collectTranscriptHead(
    input.transcript,
    input.limit,
    messageFromClaudeEvent
  );
}
function messageFromClaudeEvent(event) {
  const message = isObject(event.message) ? event.message : void 0;
  const role = normalizeRole(event.type) ?? normalizeRole(message?.role);
  if (!role) {
    return null;
  }
  const text = textFromContent(message?.content ?? event.content);
  return text ? { role, text } : null;
}

// ../../packages/core/src/codex-adapter.ts
import { existsSync as existsSync2, readFileSync as readFileSync2, readdirSync as readdirSync3 } from "fs";
import { basename, join as join3, resolve as resolve3 } from "path";
function parseCodexTranscript(input) {
  let id;
  let model;
  const filenameId = codexThreadIdFromPath(input.transcriptPath);
  let turnCompletedTotals = emptyTokenTotals();
  let lastDesktopTotals = null;
  for (const line of input.transcript.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "thread.started") {
      id ??= event.thread_id ?? event.threadId ?? event.id;
      model ??= event.model;
    }
    if (event.type === "session_meta") {
      id ??= event.payload?.id;
    }
    if (event.type === "turn.completed") {
      turnCompletedTotals = addTokenTotals(
        turnCompletedTotals,
        tokenTotalsFromUsage(event.usage ?? event.turn?.usage)
      );
    }
    if (event.type === "event_msg" && event.payload?.type === "token_count") {
      const usage2 = event.payload.info?.total_token_usage;
      if (usage2) {
        lastDesktopTotals = desktopTokenTotals(usage2);
      }
    }
  }
  if (!id) {
    throw new Error("Codex transcript does not include a thread.started id");
  }
  if (filenameId && filenameId !== id) {
    throw new Error(
      `Codex transcript id ${id} does not match filename id ${filenameId}`
    );
  }
  if (input.expectedThreadId && input.expectedThreadId !== id) {
    throw new Error(
      `Codex transcript id ${id} does not match expected thread id ${input.expectedThreadId}`
    );
  }
  return {
    id,
    transcriptPath: input.transcriptPath,
    tool: "codex",
    model: model ?? null,
    tokenTotals: lastDesktopTotals ?? turnCompletedTotals
  };
}
function desktopTokenTotals(usage2) {
  const inputTokens = usage2.input_tokens ?? 0;
  const outputTokens = usage2.output_tokens ?? 0;
  const cacheReadInputTokens = usage2.cached_input_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens,
    totalTokens: usage2.total_tokens ?? inputTokens + outputTokens
  };
}
function parseCodexTranscriptFile(transcriptPath, options = {}) {
  return parseCodexTranscript({
    transcript: readFileSync2(transcriptPath, "utf8"),
    transcriptPath,
    expectedThreadId: options.expectedThreadId
  });
}
function tailCodexTranscript(input) {
  return collectTranscriptTail(
    input.transcript,
    input.limit,
    messageFromCodexEvent
  );
}
function headCodexTranscript(input) {
  return collectTranscriptHead(
    input.transcript,
    input.limit,
    messageFromCodexEvent
  );
}
function messageFromCodexEvent(event) {
  const type = typeof event.type === "string" ? event.type : "";
  const role = normalizeRole(event.role) ?? (type === "turn.started" || type === "user_message" ? "user" : void 0) ?? (type === "agent_message" || type === "assistant_message" ? "assistant" : void 0);
  if (!role) {
    return null;
  }
  const text = textFromContent(
    event.message ?? event.prompt ?? event.content ?? event.text
  );
  return text ? { role, text } : null;
}
function scanCodexSessions(codexHome) {
  const root = resolve3(codexHome);
  const indexedPaths = readCodexSessionIndex(root);
  const transcriptPaths = indexedPaths.length > 0 ? indexedPaths : findJsonlFiles2(join3(root, "sessions"));
  return transcriptPaths.flatMap((entry) => {
    try {
      return [
        parseCodexTranscriptFile(entry.transcriptPath, {
          expectedThreadId: entry.expectedThreadId
        })
      ];
    } catch {
      return [];
    }
  });
}
function readCodexSessionIndex(codexHome) {
  const indexPath = join3(codexHome, "session_index.jsonl");
  if (!existsSync2(indexPath)) {
    return [];
  }
  return readFileSync2(indexPath, "utf8").split(/\r?\n/).filter((line) => line.trim().length > 0).flatMap((line) => {
    const entry = JSON.parse(line);
    const rawPath = entry.path ?? entry.transcript_path ?? entry.transcriptPath ?? entry.rollout_path ?? entry.rolloutPath;
    if (!rawPath) {
      return [];
    }
    return [
      {
        transcriptPath: resolve3(codexHome, rawPath),
        expectedThreadId: entry.thread_id ?? entry.threadId ?? entry.id
      }
    ];
  });
}
function findJsonlFiles2(directoryPath) {
  if (!existsSync2(directoryPath)) {
    return [];
  }
  return readdirSync3(directoryPath, { withFileTypes: true }).flatMap(
    (entry) => {
      const fullPath = join3(directoryPath, entry.name);
      if (entry.isDirectory()) {
        return findJsonlFiles2(fullPath);
      }
      return entry.isFile() && entry.name.endsWith(".jsonl") ? [{ transcriptPath: fullPath }] : [];
    }
  ).sort(
    (left, right) => left.transcriptPath.localeCompare(right.transcriptPath)
  );
}
function codexThreadIdFromPath(transcriptPath) {
  const filename = basename(transcriptPath).replace(/\.jsonl$/, "");
  if (!filename.length) return void 0;
  const uuidMatch = filename.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
  );
  if (uuidMatch) return uuidMatch[1];
  return filename.replace(/^rollout-/, "");
}

// ../../packages/core/src/transcript-adapter.ts
var claudeTranscriptAdapter = {
  tool: "claude",
  parse(input) {
    return parseClaudeCodeTranscript({
      transcript: input.transcript,
      transcriptPath: input.transcriptPath
    });
  },
  parseFile(transcriptPath) {
    return parseClaudeCodeTranscriptFile(transcriptPath);
  },
  head(input) {
    return headClaudeCodeTranscript(input);
  },
  readHead(input) {
    return readFromFile(input, headClaudeCodeTranscript);
  },
  tail(input) {
    return tailClaudeCodeTranscript(input);
  },
  readTail(input) {
    return readFromFile(input, tailClaudeCodeTranscript);
  }
};
var codexTranscriptAdapter = {
  tool: "codex",
  parse(input) {
    return parseCodexTranscript({
      transcript: input.transcript,
      transcriptPath: input.transcriptPath,
      expectedThreadId: input.expectedId
    });
  },
  parseFile(transcriptPath, options) {
    return parseCodexTranscriptFile(transcriptPath, {
      expectedThreadId: options?.expectedId
    });
  },
  head(input) {
    return headCodexTranscript(input);
  },
  readHead(input) {
    return readFromFile(input, headCodexTranscript);
  },
  tail(input) {
    return tailCodexTranscript(input);
  },
  readTail(input) {
    return readFromFile(input, tailCodexTranscript);
  }
};
var adaptersByTool = {
  claude: claudeTranscriptAdapter,
  codex: codexTranscriptAdapter
};
function getTranscriptAdapter(tool) {
  return adaptersByTool[tool];
}
function readFromFile(input, walk) {
  try {
    return walk({
      transcript: readFileSync3(input.transcriptPath, "utf8"),
      limit: input.limit
    });
  } catch {
    return [];
  }
}

// ../../packages/core/src/session-name.ts
var SESSION_NAME_MAX_LENGTH = 60;
function readSessionName(transcriptPath, tool = "claude") {
  return nameFromHead(getTranscriptAdapter(tool).readHead({ transcriptPath }));
}
function nameFromHead(messages) {
  for (const message of messages) {
    const cleaned = cleanMessageText(message.text);
    if (!cleaned) continue;
    return cleaned.length > SESSION_NAME_MAX_LENGTH ? cleaned.slice(0, SESSION_NAME_MAX_LENGTH) + "\u2026" : cleaned;
  }
  return null;
}
function cleanMessageText(text) {
  const trimmed = text.trim();
  if (trimmed.includes("<command-name>")) {
    const args = trimmed.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1];
    const cleanedArgs = args?.trim();
    return cleanedArgs && cleanedArgs.length > 0 ? cleanedArgs : null;
  }
  if (trimmed.startsWith("/")) return null;
  if (trimmed.includes("<system-reminder")) return null;
  if (trimmed.includes("<local-command")) return null;
  return trimmed;
}

// ../../packages/core/src/store.ts
function openTraceStore(databasePath) {
  return new NodeSqliteTaskStore(databasePath);
}
var NodeSqliteTaskStore = class {
  #sqlite;
  #databasePath;
  constructor(databasePath) {
    const resolvedPath = resolve4(databasePath);
    this.#databasePath = resolvedPath;
    mkdirSync(dirname2(resolvedPath), { recursive: true });
    this.#sqlite = new DatabaseSync(resolvedPath);
    this.#sqlite.exec("PRAGMA journal_mode = WAL");
    this.#sqlite.exec("PRAGMA foreign_keys = ON");
    applyMigrations(this.#sqlite);
    this.#backfillSlugs();
  }
  createTask(title, projectRoot = "", description) {
    const trimmedTitle = title.trim();
    const normalizedTitle = looksLikeSlug(trimmedTitle) ? humanizeSlug(trimmedTitle) : trimmedTitle;
    const normalizedProjectRoot = projectRoot.trim();
    const normalizedDescription = description?.trim() || void 0;
    const id = randomUUID();
    const task = {
      id,
      title: normalizedTitle,
      slug: this.#allocateSlug(slugify(normalizedTitle), id),
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      projectRoot: normalizedProjectRoot,
      archivedAt: null
    };
    if (normalizedDescription) task.description = normalizedDescription;
    this.#sqlite.prepare(
      `
          INSERT INTO tasks (id, title, slug, created_at, project_root, archived_at, description)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `
    ).run(
      task.id,
      task.title,
      task.slug,
      task.createdAt,
      task.projectRoot,
      task.archivedAt,
      task.description ?? null
    );
    return task;
  }
  getTask(id) {
    const row = this.#sqlite.prepare(
      "SELECT id, title, slug, created_at, project_root, archived_at, description FROM tasks WHERE id = ?"
    ).get(id);
    return row ? taskFromRow(row) : null;
  }
  getTaskByRef(ref) {
    const trimmed = ref.trim();
    if (trimmed.length === 0) return null;
    const byId = this.getTask(trimmed);
    if (byId) return byId;
    const row = this.#sqlite.prepare(
      "SELECT id, title, slug, created_at, project_root, archived_at, description FROM tasks WHERE slug = ?"
    ).get(trimmed);
    return row ? taskFromRow(row) : null;
  }
  listTasks() {
    return this.#sqlite.prepare(
      `
          SELECT id, title, slug, created_at, project_root, archived_at, description
          FROM tasks
          ORDER BY created_at ASC, id ASC
        `
    ).all().map((row) => taskFromRow(row));
  }
  listTaskSummaries() {
    return this.listTasks().map((task) => {
      const sessions = this.listSessionsForTask(task.id);
      const docs = this.listDocsForTask(task.id);
      const lastActivityAt = [
        ...sessions.map((session) => session.createdAt),
        ...docs.map((doc) => doc.createdAt)
      ].reduce(
        (latest, current) => current > latest ? current : latest,
        task.createdAt
      );
      const tokenTotals = sessions.reduce(
        (totals, session) => addTokenTotals(totals, session.tokenTotals),
        emptyTokenTotals()
      );
      return { ...task, lastActivityAt, tokenTotals };
    });
  }
  recallCandidates(projectRoot) {
    const rows = this.#sqlite.prepare(
      `
          SELECT title, slug, description
          FROM tasks
          WHERE project_root = ? AND archived_at IS NULL
          ORDER BY created_at ASC, id ASC
        `
    ).all(projectRoot.trim());
    return rows.map((row) => {
      const candidate = { title: row.title, slug: row.slug };
      if (row.description != null) candidate.description = row.description;
      return candidate;
    });
  }
  // Resolve the active task for a session in a project, encapsulating the
  // "session binding first, project recency fallback" rule behind one call so
  // the SessionStart hook stays a thin caller. A session already bound to an
  // unarchived task wins (positive case). Otherwise — unbound, or bound to a
  // task that has since been archived or deleted — the project's most recent
  // unarchived task is offered for re-entry, falling through to `none` when the
  // project has no task to bind to yet.
  resolveActiveTask(sessionId, projectRoot) {
    const session = this.getSession(sessionId);
    if (session?.taskId) {
      const bound = this.getTask(session.taskId);
      if (bound && !bound.archivedAt) {
        return { kind: "bound", task: bound };
      }
    }
    const recent = this.#mostRecentTask(projectRoot);
    return recent ? { kind: "re-enter", task: recent } : { kind: "none" };
  }
  #mostRecentTask(projectRoot) {
    const row = this.#sqlite.prepare(
      `
          SELECT id, title, slug, created_at, project_root, archived_at, description
          FROM tasks
          WHERE project_root = ? AND archived_at IS NULL
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1
        `
    ).get(projectRoot.trim());
    return row ? taskFromRow(row) : null;
  }
  updateTaskDescription(ref, description) {
    const task = this.getTaskByRef(ref);
    if (!task) throw new Error(`Task not found: ${ref}`);
    const normalizedDescription = description.trim() || void 0;
    this.#sqlite.prepare("UPDATE tasks SET description = ? WHERE id = ?").run(normalizedDescription ?? null, task.id);
    const updated = { ...task };
    if (normalizedDescription) updated.description = normalizedDescription;
    else delete updated.description;
    return updated;
  }
  archiveTask(ref) {
    const task = this.getTaskByRef(ref);
    if (!task) throw new Error(`Task not found: ${ref}`);
    const archivedAt = (/* @__PURE__ */ new Date()).toISOString();
    this.#sqlite.prepare("UPDATE tasks SET archived_at = ? WHERE id = ?").run(archivedAt, task.id);
    return { ...task, archivedAt };
  }
  unarchiveTask(ref) {
    const task = this.getTaskByRef(ref);
    if (!task) throw new Error(`Task not found: ${ref}`);
    this.#sqlite.prepare("UPDATE tasks SET archived_at = NULL WHERE id = ?").run(task.id);
    return { ...task, archivedAt: null };
  }
  registerSession(input) {
    const id = input.id.trim();
    const transcriptPath = input.transcriptPath.trim();
    const model = input.model?.trim() || null;
    if (id.length === 0) {
      throw new Error("Session id is required");
    }
    if (transcriptPath.length === 0) {
      throw new Error("Session transcript path is required");
    }
    if (input.tool !== "claude" && input.tool !== "codex") {
      throw new Error("Session tool must be claude or codex");
    }
    const existing = this.getSession(id);
    if (existing) {
      if (existing.transcriptPath.startsWith("codex:") && !transcriptPath.startsWith("codex:")) {
        this.#sqlite.prepare("UPDATE sessions SET transcript_path = ? WHERE id = ?").run(transcriptPath, id);
        return this.#refreshSession({ ...existing, transcriptPath });
      }
      return existing;
    }
    const totals = tokenTotalsFromUsage(input.tokenTotals);
    const session = {
      id,
      transcriptPath,
      tool: input.tool,
      model,
      taskId: null,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      tokenTotals: totals
    };
    this.#sqlite.prepare(
      `
          INSERT INTO sessions (
            id,
            transcript_path,
            tool,
            model,
            task_id,
            created_at,
            input_tokens,
            output_tokens,
            cache_creation_input_tokens,
            cache_read_input_tokens,
            total_tokens
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
    ).run(
      session.id,
      session.transcriptPath,
      session.tool,
      session.model,
      session.taskId,
      session.createdAt,
      totals.inputTokens,
      totals.outputTokens,
      totals.cacheCreationInputTokens,
      totals.cacheReadInputTokens,
      totals.totalTokens
    );
    return session;
  }
  assignSession(sessionId, taskId) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const task = this.getTaskByRef(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    this.#sqlite.prepare("UPDATE sessions SET task_id = ? WHERE id = ?").run(task.id, session.id);
    return { ...session, taskId: task.id };
  }
  listUnassignedSessions() {
    return this.#sqlite.prepare(
      `
          SELECT *
          FROM sessions
          WHERE task_id IS NULL
          ORDER BY created_at ASC, id ASC
        `
    ).all().map((row) => this.#refreshSession(sessionFromRow(row)));
  }
  listSessionsForTask(taskId) {
    return this.#sqlite.prepare(
      `
          SELECT *
          FROM sessions
          WHERE task_id = ?
          ORDER BY created_at ASC, id ASC
        `
    ).all(taskId).map((row) => this.#refreshSession(sessionFromRow(row)));
  }
  getTaskTimeline(taskId) {
    const task = this.getTaskByRef(taskId);
    if (!task) return null;
    const sessionList = this.listSessionsForTask(task.id);
    const docs = this.listDocsForTask(task.id);
    const items = [
      ...sessionList.map(
        (session) => ({
          type: "session",
          createdAt: session.createdAt,
          session,
          sessionName: readSessionName(session.transcriptPath, session.tool)
        })
      ),
      ...docs.map(
        (doc) => ({
          type: "doc",
          createdAt: doc.createdAt,
          doc,
          sizeBytes: readFileSizeBytes(doc.path)
        })
      )
    ].sort(compareTimelineItems);
    return {
      task,
      items,
      tokenTotals: sessionList.reduce(
        (totals, session) => addTokenTotals(totals, session.tokenTotals),
        emptyTokenTotals()
      )
    };
  }
  getReEntryManifest(taskId) {
    const task = this.getTaskByRef(taskId);
    if (!task) return null;
    const sessions = this.listSessionsForTask(task.id).slice().sort(compareSessionsNewestFirst).map((session, index) => ({
      id: session.id,
      transcriptPath: session.transcriptPath,
      tool: session.tool,
      model: session.model,
      createdAt: session.createdAt,
      isMostRecent: index === 0
    }));
    const allDocs = this.listDocsForTask(task.id);
    const stateDoc = allDocs.find((d) => basename2(d.path) === "state.md");
    const docs = allDocs.filter((d) => basename2(d.path) !== "state.md");
    return {
      task: {
        id: task.id,
        title: task.title,
        projectRoot: task.projectRoot,
        // Description stays optional/absent (never null), matching the Task
        // convention — only surface the key when the task actually has one.
        ...task.description ? { description: task.description } : {}
      },
      taskDocsDir: resolveTaskDocsDir(this.#databasePath, task.slug),
      ...stateDoc ? { state: stateDoc } : {},
      docs,
      sessions
    };
  }
  addTaskDoc(taskId, path) {
    const task = this.getTaskByRef(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const normalizedPath = path.trim();
    if (normalizedPath.length === 0) {
      throw new Error("Task doc path is required");
    }
    const existing = this.getTaskDoc(task.id, normalizedPath);
    if (existing) return existing;
    const doc = {
      taskId: task.id,
      path: normalizedPath,
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    this.#sqlite.prepare(
      `
          INSERT INTO task_docs (task_id, path, created_at)
          VALUES (?, ?, ?)
        `
    ).run(doc.taskId, doc.path, doc.createdAt);
    return doc;
  }
  listDocsForTask(taskId) {
    const task = this.getTaskByRef(taskId);
    const id = task?.id ?? taskId;
    const registeredDocs = this.#sqlite.prepare(
      `
          SELECT task_id, path, created_at
          FROM task_docs
          WHERE task_id = ?
          ORDER BY created_at ASC, path ASC
        `
    ).all(id).map((row) => taskDocFromRow(row));
    return mergeTaskDocs(
      registeredDocs,
      task?.slug ? listNativeTaskDocs(this.#databasePath, id, task.slug) : []
    );
  }
  removeTaskDoc(taskId, path) {
    this.#sqlite.prepare("DELETE FROM task_docs WHERE task_id = ? AND path = ?").run(taskId, path.trim());
  }
  close() {
    this.#sqlite.close();
  }
  getSession(id) {
    const row = this.#sqlite.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
    if (!row) return null;
    return this.#refreshSession(sessionFromRow(row));
  }
  #refreshSession(session) {
    let fresh = null;
    try {
      const adapter = getTranscriptAdapter(session.tool);
      const parsed = adapter.parseFile(session.transcriptPath, {
        expectedId: session.id
      });
      fresh = { tokenTotals: parsed.tokenTotals, model: parsed.model };
    } catch {
      return session;
    }
    const totals = fresh.tokenTotals;
    const stored = session.tokenTotals;
    const changed = totals.inputTokens !== stored.inputTokens || totals.outputTokens !== stored.outputTokens || totals.cacheCreationInputTokens !== stored.cacheCreationInputTokens || totals.cacheReadInputTokens !== stored.cacheReadInputTokens || totals.totalTokens !== stored.totalTokens;
    if (changed) {
      this.#sqlite.prepare(
        `
            UPDATE sessions
            SET
              input_tokens = ?,
              output_tokens = ?,
              cache_creation_input_tokens = ?,
              cache_read_input_tokens = ?,
              total_tokens = ?
            WHERE id = ?
          `
      ).run(
        totals.inputTokens,
        totals.outputTokens,
        totals.cacheCreationInputTokens,
        totals.cacheReadInputTokens,
        totals.totalTokens,
        session.id
      );
    }
    return { ...session, tokenTotals: totals };
  }
  // Reserve a unique slug. An empty base (untitled task or a title that left
  // nothing slug-worthy) falls back to a placeholder derived from the id, as
  // does a base that reads as a UUID (it would shadow id lookups in
  // getTaskByRef); otherwise collisions get a numeric suffix.
  #allocateSlug(base, id) {
    const candidate = base.length > 0 && !looksLikeTaskId(base) ? base : generatePlaceholderSlug(id);
    if (!this.#slugExists(candidate)) {
      return candidate;
    }
    for (let suffix = 2; ; suffix += 1) {
      const next = `${candidate}-${suffix}`;
      if (!this.#slugExists(next)) {
        return next;
      }
    }
  }
  #slugExists(slug) {
    const row = this.#sqlite.prepare("SELECT 1 FROM tasks WHERE slug = ? LIMIT 1").get(slug);
    return row !== void 0;
  }
  // After migrations, any task row missing a slug (rows that predate the slug
  // column) is backfilled deterministically by creation order so suffixing is
  // stable, then locked in by the unique index.
  #backfillSlugs() {
    const rows = this.#sqlite.prepare(
      `
          SELECT id, title
          FROM tasks
          WHERE slug IS NULL
          ORDER BY created_at ASC, id ASC
        `
    ).all();
    if (rows.length === 0) return;
    const update = this.#sqlite.prepare(
      "UPDATE tasks SET slug = ? WHERE id = ?"
    );
    for (const row of rows) {
      const slug = this.#allocateSlug(slugify(row.title.trim()), row.id);
      update.run(slug, row.id);
    }
  }
  getTaskDoc(taskId, path) {
    const row = this.#sqlite.prepare(
      `
          SELECT task_id, path, created_at
          FROM task_docs
          WHERE task_id = ? AND path = ?
        `
    ).get(taskId, path);
    return row ? taskDocFromRow(row) : null;
  }
};
function applyMigrations(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric
    )
  `);
  const lastMigration = database.prepare(
    `
        SELECT created_at
        FROM "__drizzle_migrations"
        ORDER BY created_at DESC
        LIMIT 1
      `
  ).get();
  const lastAppliedAt = Number(lastMigration?.created_at ?? 0);
  database.exec("BEGIN");
  try {
    for (const entry of migrationJournal.entries) {
      if (lastAppliedAt >= entry.when) continue;
      const migrationSql = migrationSqlByTag[entry.tag];
      if (!migrationSql) {
        throw new Error(`Missing migration SQL for ${entry.tag}`);
      }
      for (const statement of splitMigrationStatements(
        migrationSql,
        entry.breakpoints
      )) {
        database.exec(statement);
      }
      database.prepare(
        'INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)'
      ).run(hashMigration(migrationSql), entry.when);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
function splitMigrationStatements(sql, breakpoints) {
  if (breakpoints) {
    return sql.split("--> statement-breakpoint").map((statement2) => statement2.trim()).filter((statement2) => statement2.length > 0);
  }
  const statement = sql.trim();
  return statement.length > 0 ? [statement] : [];
}
function hashMigration(sql) {
  return `${sql.length}:${sql}`;
}
function taskFromRow(row) {
  const task = {
    id: row.id,
    title: row.title,
    slug: row.slug,
    createdAt: row.created_at,
    projectRoot: row.project_root,
    archivedAt: row.archived_at
  };
  if (row.description != null) task.description = row.description;
  return task;
}
function sessionFromRow(row) {
  return {
    id: row.id,
    transcriptPath: row.transcript_path,
    tool: row.tool,
    model: row.model,
    taskId: row.task_id,
    createdAt: row.created_at,
    tokenTotals: {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheCreationInputTokens: row.cache_creation_input_tokens,
      cacheReadInputTokens: row.cache_read_input_tokens,
      totalTokens: row.total_tokens
    }
  };
}
function taskDocFromRow(row) {
  return {
    taskId: row.task_id,
    path: row.path,
    createdAt: row.created_at
  };
}
function compareTimelineItems(left, right) {
  const byCreatedAt = left.createdAt.localeCompare(right.createdAt);
  if (byCreatedAt !== 0) return byCreatedAt;
  const leftKey = left.type === "session" ? `session:${left.session.id}` : `doc:${left.doc.path}`;
  const rightKey = right.type === "session" ? `session:${right.session.id}` : `doc:${right.doc.path}`;
  return leftKey.localeCompare(rightKey);
}
function readFileSizeBytes(path) {
  try {
    return statSync2(path).size;
  } catch {
    return null;
  }
}
function compareSessionsNewestFirst(left, right) {
  const byCreatedAt = right.createdAt.localeCompare(left.createdAt);
  if (byCreatedAt !== 0) return byCreatedAt;
  return right.id.localeCompare(left.id);
}

// ../../packages/core/src/api-handler.ts
import { homedir } from "os";
var JSON_CONTENT_TYPE = "application/json";
function handleTraceApiRequest(databasePath, method, rawUrl) {
  const path = rawUrl.split("?", 1)[0] ?? rawUrl;
  if (path === "/api/config") {
    if (method !== "GET") return methodNotAllowed();
    return json({ home: homedir() });
  }
  if (path !== "/api/tasks" && !path.startsWith("/api/tasks/")) {
    return path.startsWith("/api/") ? notFound() : null;
  }
  try {
    if (path === "/api/tasks" || path === "/api/tasks/") {
      if (method !== "GET") return methodNotAllowed();
      const store = openTraceStore(databasePath);
      try {
        return json(store.listTaskSummaries());
      } finally {
        store.close();
      }
    }
    const archiveMatch = /^\/api\/tasks\/([^/]+)\/(archive|unarchive)\/?$/.exec(
      path
    );
    if (archiveMatch?.[1] && archiveMatch[2]) {
      if (method !== "POST") return methodNotAllowed();
      const store = openTraceStore(databasePath);
      try {
        const ref = decodeURIComponent(archiveMatch[1]);
        const task = archiveMatch[2] === "archive" ? store.archiveTask(ref) : store.unarchiveTask(ref);
        return json(task);
      } finally {
        store.close();
      }
    }
    const match = /^\/api\/tasks\/([^/]+)\/timeline\/?$/.exec(path);
    if (match?.[1]) {
      if (method !== "GET") return methodNotAllowed();
      const store = openTraceStore(databasePath);
      try {
        const timeline = store.getTaskTimeline(decodeURIComponent(match[1]));
        return timeline ? json(timeline) : notFound();
      } finally {
        store.close();
      }
    }
    return notFound();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Task not found:")) {
      return { status: 404, body: error.message };
    }
    return {
      status: 500,
      body: error instanceof Error ? error.message : String(error)
    };
  }
}
function writeTraceApiResponse(sink, response) {
  sink.statusCode = response.status;
  if (response.contentType) {
    sink.setHeader("content-type", response.contentType);
  }
  sink.end(response.body);
}
function json(payload) {
  return {
    status: 200,
    body: JSON.stringify(payload),
    contentType: JSON_CONTENT_TYPE
  };
}
function notFound() {
  return { status: 404, body: "" };
}
function methodNotAllowed() {
  return { status: 405, body: "" };
}

// ../../packages/core/src/project-root.ts
import { existsSync as existsSync3 } from "fs";
import { dirname as dirname3, resolve as resolve5 } from "path";
function resolveProjectRoot(cwd) {
  const start = resolve5(cwd);
  let current = start;
  while (true) {
    if (existsSync3(resolve5(current, ".git"))) {
      return current;
    }
    const parent = dirname3(current);
    if (parent === current) {
      return start;
    }
    current = parent;
  }
}
function resolveProjectRootArg(projectArg, cwd) {
  if (projectArg === void 0) {
    return resolveProjectRoot(cwd);
  }
  const target = resolve5(cwd, projectArg);
  if (!existsSync3(target)) {
    throw new Error(`--project path does not exist: ${target}`);
  }
  return resolveProjectRoot(target);
}

// ../../packages/core/src/db-path.ts
import { join as join4 } from "path";
function resolveDatabasePath(env) {
  if (env.TRACE_DB) return env.TRACE_DB;
  if (env.HOME) return join4(env.HOME, ".trace", "trace.sqlite");
  throw new Error(
    "TRACE_DB must be set, or HOME must be available for the default path ~/.trace/trace.sqlite"
  );
}

// ../../packages/core/src/session-identity.ts
function inferSessionIdentity(env, overrides = {}) {
  const tool = overrides.tool ?? inferTool(env);
  const id = present(overrides.id) ?? inferId(tool, env);
  const transcriptPath = present(overrides.transcriptPath) ?? (id === void 0 ? void 0 : inferTranscriptPath(id, tool, env));
  return { tool, id, transcriptPath };
}
function present(value) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : void 0;
}
function inferTool(env) {
  if (present(env.CODEX_THREAD_ID)) {
    return "codex";
  }
  return "claude";
}
function inferId(tool, env) {
  if (tool === "codex") {
    return present(env.CODEX_THREAD_ID);
  }
  return present(env.CLAUDE_CODE_SESSION_ID) ?? present(env.CLAUDE_SESSION_ID) ?? present(env.session_id);
}
function inferTranscriptPath(id, tool, env) {
  const claudePath = present(env.CLAUDE_TRANSCRIPT_PATH);
  if (tool === "claude" && claudePath) {
    return claudePath;
  }
  const codexPath = present(env.CODEX_TRANSCRIPT_PATH);
  if (tool === "codex" && codexPath) {
    return codexPath;
  }
  return `${tool}:${id}`;
}

// src/db-path.ts
function resolveDbPath(env) {
  return resolveDatabasePath(env);
}

// src/installer.ts
import { existsSync as existsSync4, mkdirSync as mkdirSync2, readFileSync as readFileSync4, writeFileSync } from "fs";
import { dirname as dirname4, join as join5 } from "path";
import { fileURLToPath } from "url";
function runInit(env, cwd) {
  const skillPath = resolveTraceSkillPath(cwd);
  const codexSkillResult = installCodexSkill(env);
  const lines = [
    "trace is now installed through the Claude Code plugin.",
    "setup: /plugin marketplace add arielbk/trace-v2",
    "setup: /plugin install trace@trace-v2",
    existsSync4(skillPath) ? `trace skill: found at ${skillPath}` : `trace skill: missing at ${skillPath}`,
    codexSkillResult,
    "SessionStart registration is declared by hooks/hooks.json in the plugin."
  ];
  return `${lines.join("\n")}
`;
}
function installCodexSkill(env) {
  if (!env.HOME) {
    return "Codex trace skill: skipped because HOME is not set";
  }
  const targetPath = join5(env.HOME, ".agents", "skills", "trace", "SKILL.md");
  const pluginRoot = resolvePluginRoot();
  const sourcePath = join5(pluginRoot, "codex", "skills", "trace", "SKILL.md");
  const bundledTraceBin = join5(pluginRoot, "bin", "trace.js");
  const source = readFileSync4(sourcePath, "utf8");
  const rendered = source.replaceAll(
    'node "<trace-plugin-root>/bin/trace.js"',
    `node "${bundledTraceBin}"`
  ).replaceAll("<trace-plugin-root>", pluginRoot);
  if (existsSync4(targetPath) && readFileSync4(targetPath, "utf8") === rendered) {
    return `Codex trace skill: already present at ${targetPath}`;
  }
  mkdirSync2(dirname4(targetPath), { recursive: true });
  writeFileSync(targetPath, rendered);
  return `Codex trace skill: installed at ${targetPath}`;
}
function resolveTraceSkillPath(cwd) {
  let current = cwd;
  while (true) {
    for (const candidate of [
      join5(current, "skills", "trace", "SKILL.md"),
      join5(current, ".claude", "skills", "trace", "SKILL.md")
    ]) {
      if (existsSync4(candidate)) {
        return candidate;
      }
    }
    const parent = dirname4(current);
    if (parent === current) {
      return join5(resolvePluginRoot(), "skills", "trace", "SKILL.md");
    }
    current = parent;
  }
}
function resolvePluginRoot() {
  const sourceRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const bundleDir = globalThis.__TRACE_BUNDLE_DIR__;
  const candidates = [
    sourceRoot,
    ...bundleDir ? [join5(bundleDir, ".."), join5(bundleDir, "..", "..", "..")] : []
  ];
  for (const candidate of candidates) {
    if (existsSync4(join5(candidate, "codex", "skills", "trace", "SKILL.md"))) {
      return candidate;
    }
  }
  return sourceRoot;
}

// src/serve.ts
import { spawn as nodeSpawn } from "child_process";
import { existsSync as existsSync5, readFileSync as readFileSync5, statSync as statSync3 } from "fs";
import {
  createServer
} from "http";
import { dirname as dirname5, extname, join as join6, normalize, resolve as resolve6, sep } from "path";
import { fileURLToPath as fileURLToPath2 } from "url";
var DEFAULT_SERVE_PORT = 4317;
var PORT_FALLBACK_ATTEMPTS = 10;
var CONTENT_TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain"
};
function resolveAssetFile(assetsDir, urlPath) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const root = resolve6(assetsDir);
  const candidate = normalize(join6(root, decodedPath));
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    return null;
  }
  try {
    return statSync3(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}
function serveFile(res, filePath) {
  res.statusCode = 200;
  res.setHeader(
    "content-type",
    CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream"
  );
  res.end(readFileSync5(filePath, "utf8"));
}
function createServeRequestListener(databasePath, assetsDir) {
  return (req, res) => {
    const url = req.url ?? "/";
    const response = handleTraceApiRequest(
      databasePath,
      req.method ?? "GET",
      url
    );
    if (response) {
      writeTraceApiResponse(res, response);
      return;
    }
    const urlPath = url.split("?", 1)[0] ?? url;
    const assetFile = assetsDir ? resolveAssetFile(assetsDir, urlPath) ?? // SPA fallback: client-side routes resolve to index.html.
    resolveAssetFile(assetsDir, "/index.html") : null;
    if (assetFile) {
      serveFile(res, assetFile);
      return;
    }
    res.statusCode = 404;
    res.end();
  };
}
var defaultBrowserSpawn = (command, args) => nodeSpawn(command, args, { detached: true, stdio: "ignore" });
function openBrowser(url, platform = process.platform, spawn = defaultBrowserSpawn) {
  const [command, args] = platform === "darwin" ? ["open", [url]] : platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    const child = spawn(command, args);
    child.on("error", () => {
    });
    child.unref();
  } catch {
  }
}
function resolveWebAssetsDir(moduleDir = dirname5(fileURLToPath2(import.meta.url)), bundleDir = globalThis.__TRACE_BUNDLE_DIR__) {
  if (bundleDir) {
    const bundledAssets = resolve6(bundleDir, "web");
    if (existsSync5(join6(bundledAssets, "index.html"))) return bundledAssets;
  }
  const distAssets = resolve6(moduleDir, "web");
  if (existsSync5(join6(distAssets, "index.html"))) return distAssets;
  const candidate = resolve6(moduleDir, "../../web/dist");
  return existsSync5(join6(candidate, "index.html")) ? candidate : void 0;
}
function createTraceServeServer(env, assetsDir = resolveWebAssetsDir()) {
  return createServer(createServeRequestListener(resolveDbPath(env), assetsDir));
}
function startTraceServe(env, options = {}) {
  const host = options.host ?? "127.0.0.1";
  const preferredPort = options.port ?? DEFAULT_SERVE_PORT;
  const server = options.server ?? createTraceServeServer(env);
  return new Promise((resolve7, reject) => {
    const listenOn = (port, attemptsLeft) => {
      const onError = (error) => {
        if (error.code === "EADDRINUSE" && attemptsLeft > 0) {
          listenOn(port + 1, attemptsLeft - 1);
          return;
        }
        reject(error);
      };
      server.once("error", onError);
      server.listen(port, host, () => {
        server.removeListener("error", onError);
        const address = server.address();
        const boundPort = typeof address === "object" && address ? address.port : port;
        resolve7({
          url: `http://${host}:${boundPort}/`,
          port: boundPort,
          close: () => new Promise((resolveClose, rejectClose) => {
            server.close(
              (error) => error ? rejectClose(error) : resolveClose()
            );
          })
        });
      });
    };
    listenOn(preferredPort, PORT_FALLBACK_ATTEMPTS);
  });
}

// src/trace.ts
import {
  copyFileSync,
  lstatSync,
  mkdirSync as mkdirSync3,
  readFileSync as readFileSync6,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync as writeFileSync2
} from "fs";
import { basename as basename3, join as join7 } from "path";
import { fileURLToPath as fileURLToPath3 } from "url";
function runTraceCli(argv, env = process.env, cwd = process.cwd()) {
  const [resource, action, ...args] = argv;
  if (resource === "init") {
    return success(runInit(env, cwd));
  }
  if (resource === "serve") {
    startTraceServe(env).then(({ url }) => {
      process.stdout.write(`trace serve listening on ${url}
`);
      openBrowser(url);
    }).catch((error) => {
      process.stderr.write(
        `trace serve failed: ${error instanceof Error ? error.message : String(error)}
`
      );
      process.exitCode = 1;
    });
    return success("");
  }
  let databasePath;
  try {
    databasePath = resolveDbPath(env);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
  const store = openTraceStore(databasePath);
  try {
    if (resource === "task") {
      if (action === "create") {
        if (isHelpFlag(args[0])) {
          return success(`${taskCreateUsage()}
`);
        }
        const titleError = rejectFlagTitle(args[0], "task create");
        if (titleError) return titleError;
        let parsedCreate;
        try {
          parsedCreate = parseTaskCreateArgs(args);
        } catch (error) {
          return failure(
            error instanceof Error ? error.message : String(error)
          );
        }
        let createProjectRoot;
        try {
          createProjectRoot = resolveProjectRootArg(parsedCreate.project, cwd);
        } catch (error) {
          return failure(
            error instanceof Error ? error.message : String(error)
          );
        }
        const task = store.createTask(
          parsedCreate.title,
          createProjectRoot,
          parsedCreate.description
        );
        return success(`${task.slug}
`);
      }
      if (action === "update") {
        if (isHelpFlag(args[0])) {
          return success(`${taskUpdateUsage()}
`);
        }
        let parsedUpdate;
        try {
          parsedUpdate = parseTaskUpdateArgs(args);
        } catch (error) {
          return failure(
            error instanceof Error ? error.message : String(error)
          );
        }
        let task;
        try {
          task = store.updateTaskDescription(
            parsedUpdate.ref,
            parsedUpdate.description
          );
        } catch (error) {
          return failure(
            error instanceof Error ? error.message : String(error),
            1
          );
        }
        return success(
          formatTask(
            task,
            store.listSessionsForTask(task.id),
            store.listDocsForTask(task.id)
          )
        );
      }
      if (action === "capture") {
        if (isHelpFlag(args[0])) {
          return success(`${taskCaptureUsage()}
`);
        }
        const titleError = rejectFlagTitle(args[0], "task capture");
        if (titleError) return titleError;
        let parsed;
        try {
          parsed = parseTaskCaptureArgs(args);
        } catch (error) {
          return failure(
            error instanceof Error ? error.message : String(error)
          );
        }
        let projectRoot;
        try {
          projectRoot = resolveProjectRootArg(parsed.project, cwd);
        } catch (error) {
          return failure(
            error instanceof Error ? error.message : String(error)
          );
        }
        const contents = parsed.docPath ? readFileSync6(parsed.docPath, "utf8") : readFileSync6(0, "utf8");
        const docFileName = parsed.docPath ? basename3(parsed.docPath) : "capture.md";
        const task = store.createTask(parsed.title, projectRoot);
        const docsDir = resolveTaskDocsDir(databasePath, task.id);
        mkdirSync3(docsDir, { recursive: true });
        const docPath = join7(docsDir, docFileName);
        if (parsed.docPath) {
          copyFileSync(parsed.docPath, docPath);
        } else {
          writeFileSync2(docPath, contents);
        }
        store.addTaskDoc(task.id, docPath);
        if (parsed.link) {
          linkRepoDocs(projectRoot, parsed.title, docsDir);
        }
        return success(`${task.id}
`);
      }
      if (action === "show") {
        const id = args[0];
        if (!id) {
          return failure("Task id is required");
        }
        const task = store.getTaskByRef(id);
        if (!task) {
          return failure(`Task not found: ${id}`, 1);
        }
        return success(
          formatTask(
            task,
            store.listSessionsForTask(task.id),
            store.listDocsForTask(task.id)
          )
        );
      }
      if (action === "list") {
        return success(store.listTasks().map(formatTaskSummary).join(""));
      }
      if (action === "timeline") {
        const id = args[0];
        const format = args[1];
        if (!id) {
          return failure("Task id is required");
        }
        if (format !== "--json") {
          return failure("Task timeline currently requires --json");
        }
        const timeline = store.getTaskTimeline(id);
        if (!timeline) {
          return failure(`Task not found: ${id}`, 1);
        }
        return success(`${JSON.stringify(timeline)}
`);
      }
      if (action === "add-doc") {
        const taskId = args[0];
        const path = args[1];
        if (!taskId) {
          return failure("Task id is required");
        }
        if (!path) {
          return failure("Task doc path is required");
        }
        const task = store.getTaskByRef(taskId);
        if (!task) {
          return failure(`Task not found: ${taskId}`, 1);
        }
        const doc = store.addTaskDoc(task.id, path);
        return success(formatTaskDocSummary(task.slug, doc));
      }
      return usage();
    }
    if (resource === "session") {
      if (action === "register") {
        const parsed = parseSessionRegisterArgs(args);
        const session = store.registerSession(parsed);
        return success(`${session.id}
`);
      }
      if (action === "assign") {
        const sessionId = args[0];
        const taskId = args[1];
        if (!sessionId) {
          return failure("Session id is required");
        }
        if (!taskId) {
          return failure("Task id is required");
        }
        const session = store.assignSession(sessionId, taskId);
        return success(formatSessionSummary(session));
      }
      if (action === "active-task") {
        let parsedActiveTask;
        try {
          parsedActiveTask = parseSessionActiveTaskArgs(args);
        } catch (error) {
          return failure(
            error instanceof Error ? error.message : String(error)
          );
        }
        let activeTaskProjectRoot;
        try {
          activeTaskProjectRoot = resolveProjectRootArg(
            parsedActiveTask.project,
            cwd
          );
        } catch (error) {
          return failure(
            error instanceof Error ? error.message : String(error)
          );
        }
        const activeTask = store.resolveActiveTask(
          parsedActiveTask.id,
          activeTaskProjectRoot
        );
        return success(`${JSON.stringify(formatActiveTask(activeTask))}
`);
      }
      if (action === "list" && args[0] === "--unassigned") {
        return success(
          store.listUnassignedSessions().map(formatSessionSummary).join("")
        );
      }
      if (action === "tail") {
        const sessionId = args[0];
        if (!sessionId) {
          return failure("Session id is required");
        }
        const session = store.getSession(sessionId);
        if (!session) {
          return failure(`Session not found: ${sessionId}`, 1);
        }
        const limit = parseSessionTailLimit(args.slice(1));
        return success(
          getTranscriptAdapter(session.tool).readTail({
            transcriptPath: session.transcriptPath,
            limit
          }).map((message) => `${message.role}: ${message.text}
`).join("")
        );
      }
      if (action === "scan" && args[0] === "--codex") {
        const codexHome = parseCodexScanArgs(args.slice(1), env);
        const sessions = scanCodexSessions(codexHome).map(
          (session) => store.registerSession({
            id: session.id,
            transcriptPath: session.transcriptPath,
            tool: session.tool,
            model: session.model,
            tokenTotals: session.tokenTotals
          })
        );
        return success(sessions.map(formatSessionSummary).join(""));
      }
      if (action === "scan" && args[0] === "--claude") {
        const projectsRoot = parseClaudeScanArgs(args.slice(1), env);
        const sessions = scanClaudeCodeSessions(projectsRoot).map(
          (session) => store.registerSession({
            id: session.id,
            transcriptPath: session.transcriptPath,
            tool: session.tool,
            model: session.model,
            tokenTotals: session.tokenTotals
          })
        );
        return success(sessions.map(formatSessionSummary).join(""));
      }
      return usage();
    }
    if (resource === "skill") {
      if (action === "work-on-task") {
        if (isHelpFlag(args[0])) {
          return success(`${skillWorkOnTaskUsage()}
`);
        }
        const titleError = rejectFlagTitle(args[0], "skill work-on-task");
        if (titleError) return titleError;
        const title = args[0];
        if (!title) {
          return failure("Task title is required");
        }
        let parsedWorkOnTask;
        try {
          parsedWorkOnTask = parseSkillWorkOnTaskArgs(args.slice(1), env);
        } catch (error) {
          return failure(
            error instanceof Error ? error.message : String(error)
          );
        }
        const { description, project, ...registerInput } = parsedWorkOnTask;
        let workOnTaskProjectRoot;
        try {
          workOnTaskProjectRoot = resolveProjectRootArg(project, cwd);
        } catch (error) {
          return failure(
            error instanceof Error ? error.message : String(error)
          );
        }
        const session = store.registerSession(registerInput);
        const resolvedTask = resolveSkillTaskRef(
          store.listTasks(),
          title,
          (id) => store.getTask(id)
        ) ?? store.createTask(title, workOnTaskProjectRoot, description);
        const task = resolvedTask.archivedAt ? store.unarchiveTask(resolvedTask.id) : resolvedTask;
        const assigned = store.assignSession(session.id, task.id);
        return success(
          formatSkillWorkOnTaskResult(assigned, task, databasePath)
        );
      }
      if (action === "recall-candidates") {
        let recallProject;
        try {
          recallProject = parseRecallCandidatesArgs(args);
        } catch (error) {
          return failure(
            error instanceof Error ? error.message : String(error)
          );
        }
        let recallProjectRoot;
        try {
          recallProjectRoot = resolveProjectRootArg(recallProject, cwd);
        } catch (error) {
          return failure(
            error instanceof Error ? error.message : String(error)
          );
        }
        const candidates = store.recallCandidates(recallProjectRoot);
        return success(`${JSON.stringify(candidates)}
`);
      }
      if (action === "re-enter") {
        if (isHelpFlag(args[0])) {
          return success(`${skillReEnterUsage()}
`);
        }
        const refError = rejectFlagTitle(args[0], "skill re-enter", "ref");
        if (refError) return refError;
        const ref = args[0];
        if (!ref) {
          return failure("Task slug or title is required");
        }
        const tasks = store.listTasks();
        const resolved = resolveSkillTaskRef(
          tasks,
          ref,
          (id) => store.getTask(id)
        );
        if (!resolved) {
          return failure(taskNotFoundMessage(tasks, ref), 1);
        }
        const manifest = store.getReEntryManifest(resolved.id);
        if (!manifest) {
          return failure(taskNotFoundMessage(tasks, ref), 1);
        }
        const identity = inferSessionIdentity(env, {});
        if (identity.id !== void 0 && identity.transcriptPath !== void 0) {
          const session = store.registerSession({
            id: identity.id,
            transcriptPath: identity.transcriptPath,
            tool: identity.tool
          });
          store.assignSession(session.id, resolved.id);
        }
        return success(formatReEntryManifest(manifest));
      }
      if (action === "docs-dir") {
        if (isHelpFlag(args[0])) {
          return success(`${skillDocsDirUsage()}
`);
        }
        let parsedDocsDir;
        try {
          parsedDocsDir = parseSkillDocsDirArgs(args);
        } catch (error) {
          return failure(
            error instanceof Error ? error.message : String(error)
          );
        }
        const identity = inferSessionIdentity(env, { id: parsedDocsDir.id });
        if (identity.id === void 0) {
          return failure(
            "Skill docs-dir requires --id or a current session env var"
          );
        }
        let docsDirProjectRoot;
        try {
          docsDirProjectRoot = resolveProjectRootArg(parsedDocsDir.project, cwd);
        } catch (error) {
          return failure(
            error instanceof Error ? error.message : String(error)
          );
        }
        const activeTask = store.resolveActiveTask(
          identity.id,
          docsDirProjectRoot
        );
        if (activeTask.kind === "bound") {
          return success(
            `taskDocsDir: ${resolveTaskDocsDir(databasePath, activeTask.task.slug)}
`
          );
        }
        if (activeTask.kind === "re-enter") {
          return failure(
            `Session is not bound to a task. Re-enter the most recent task with: trace skill re-enter ${activeTask.task.slug}`,
            1
          );
        }
        return failure(
          "Session is not bound to a task and the project has no task to re-enter. Bind one first with: trace skill work-on-task <title>",
          1
        );
      }
      return usage();
    }
    return usage();
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  } finally {
    store.close();
  }
}
function resolveSkillTaskRef(tasks, ref, getById) {
  const trimmed = ref.trim();
  if (trimmed.length === 0) return null;
  const byId = getById(trimmed);
  if (byId) return byId;
  const bySlug = tasks.find((task) => task.slug === trimmed);
  if (bySlug) return bySlug;
  const normalized = trimmed.toLowerCase();
  const byTitle = tasks.find(
    (task) => task.title.trim().toLowerCase() === normalized
  );
  return byTitle ?? null;
}
function taskNotFoundMessage(tasks, ref) {
  const needle = ref.trim().toLowerCase();
  const near = tasks.filter(
    (task) => needle.length > 0 && (task.slug.includes(needle) || task.title.toLowerCase().includes(needle))
  ).slice(0, 5);
  const lines = [`Task not found: ${ref}`];
  if (near.length > 0) {
    lines.push("Near candidates:");
    for (const task of near) {
      lines.push(`  ${task.slug} \u2014 ${task.title}`);
    }
  }
  return lines.join("\n");
}
function success(stdout) {
  return { exitCode: 0, stdout, stderr: "" };
}
function failure(stderr, exitCode = 2) {
  return { exitCode, stdout: "", stderr: `${stderr}
` };
}
function usage() {
  return failure(
    "Usage: trace init | trace serve | trace task <create|update|capture|show|list|add-doc|timeline> ... | trace session <register|assign|active-task|list|scan> ... | trace skill <work-on-task|re-enter|recall-candidates|docs-dir> ..."
  );
}
function isHelpFlag(token) {
  return token === "--help" || token === "-h";
}
function looksLikeFlag(token) {
  return token !== void 0 && token.startsWith("-");
}
function skillWorkOnTaskUsage() {
  return "Usage: trace skill work-on-task <title> [--id <id>] [--transcript <path>] [--tool <claude|codex>] [--model <name>] [--description <text>] [--project <dir>]";
}
function skillReEnterUsage() {
  return "Usage: trace skill re-enter <ref>";
}
function skillDocsDirUsage() {
  return "Usage: trace skill docs-dir [--id <session>] [--project <dir>]";
}
function parseSkillDocsDirArgs(args) {
  let id;
  let project;
  let index = 0;
  while (index < args.length) {
    const flag = args[index];
    if (flag === "--id") {
      const value = args[index + 1];
      if (!value) throw new Error(skillDocsDirUsage());
      id = value;
      index += 2;
    } else if (flag === "--project") {
      const value = args[index + 1];
      if (!value) throw new Error(skillDocsDirUsage());
      project = value;
      index += 2;
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }
  return { id, project };
}
function taskCreateUsage() {
  return "Usage: trace task create <title> [--description <text>] [--project <dir>]";
}
function parseTaskCreateArgs(args) {
  const titleWords = [];
  let description;
  let project;
  let index = 0;
  while (index < args.length && !looksLikeFlag(args[index])) {
    titleWords.push(args[index]);
    index += 1;
  }
  while (index < args.length) {
    const flag = args[index];
    if (flag === "--description") {
      const value = args[index + 1];
      if (!value) throw new Error(taskCreateUsage());
      description = value;
      index += 2;
    } else if (flag === "--project") {
      const value = args[index + 1];
      if (!value) throw new Error(taskCreateUsage());
      project = value;
      index += 2;
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }
  const title = titleWords.join(" ");
  if (title.length === 0) {
    throw new Error(taskCreateUsage());
  }
  return { title, description, project };
}
function taskUpdateUsage() {
  return "Usage: trace task update <ref> --description <text>";
}
function parseTaskUpdateArgs(args) {
  const refWords = [];
  let description;
  let index = 0;
  while (index < args.length && !looksLikeFlag(args[index])) {
    refWords.push(args[index]);
    index += 1;
  }
  while (index < args.length) {
    const flag = args[index];
    if (flag === "--description") {
      const value = args[index + 1];
      if (value === void 0) throw new Error(taskUpdateUsage());
      description = value;
      index += 2;
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }
  const ref = refWords.join(" ");
  if (ref.length === 0 || description === void 0) {
    throw new Error(taskUpdateUsage());
  }
  return { ref, description };
}
function taskCaptureUsage() {
  return "Usage: trace task capture <title> [--doc <path>] [--link] [--project <dir>]";
}
function parseTaskCaptureArgs(args) {
  const titleWords = [];
  let docPath;
  let link = false;
  let project;
  let index = 0;
  while (index < args.length && !looksLikeFlag(args[index])) {
    titleWords.push(args[index]);
    index += 1;
  }
  while (index < args.length) {
    const flag = args[index];
    if (flag === "--doc") {
      const value = args[index + 1];
      if (!value) throw new Error(taskCaptureUsage());
      docPath = value;
      index += 2;
    } else if (flag === "--link") {
      link = true;
      index += 1;
    } else if (flag === "--project") {
      const value = args[index + 1];
      if (!value) throw new Error(taskCaptureUsage());
      project = value;
      index += 2;
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }
  const title = titleWords.join(" ");
  if (title.length === 0) {
    throw new Error(taskCaptureUsage());
  }
  return { title, docPath, link, project };
}
function recallCandidatesUsage() {
  return "Usage: trace skill recall-candidates [--project <dir>]";
}
function parseRecallCandidatesArgs(args) {
  let project;
  let index = 0;
  while (index < args.length) {
    const flag = args[index];
    if (flag === "--project") {
      const value = args[index + 1];
      if (!value) throw new Error(recallCandidatesUsage());
      project = value;
      index += 2;
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }
  return project;
}
function slugify2(title) {
  return title.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "task";
}
function linkRepoDocs(projectRoot, title, docsDir) {
  const linkPath = join7(projectRoot, "docs", slugify2(title));
  mkdirSync3(join7(projectRoot, "docs"), { recursive: true });
  let existing = null;
  try {
    existing = lstatSync(linkPath);
  } catch {
    existing = null;
  }
  if (existing?.isSymbolicLink()) {
    if (realpathSync(linkPath) === realpathSync(docsDir)) {
      return;
    }
    rmSync(linkPath);
  } else if (existing) {
    throw new Error(
      `docs path already exists and is not a symlink: ${linkPath}`
    );
  }
  symlinkSync(docsDir, linkPath);
}
function rejectFlagTitle(token, command, noun = "title") {
  if (!looksLikeFlag(token)) return null;
  return failure(`Usage: trace ${command} <${noun}>`);
}
function formatTask(task, sessions = [], docs = []) {
  const lines = [
    `slug: ${task.slug}`,
    `id: ${task.id}`,
    `title: ${task.title}`,
    ...task.description ? [`description: ${task.description}`] : [],
    `createdAt: ${task.createdAt}`,
    `projectRoot: ${task.projectRoot}`
  ];
  if (sessions.length > 0) {
    lines.push(
      "sessions:",
      ...sessions.map(
        (session) => `- ${formatSessionSummary(session).trimEnd()}`
      )
    );
  }
  if (docs.length > 0) {
    lines.push("docs:", ...docs.map((doc) => `- ${doc.path}`));
  }
  return [...lines, ""].join("\n");
}
function formatTaskSummary(task) {
  return `${task.slug}	${task.title}
`;
}
function formatSessionSummary(session) {
  return `${session.id}	${session.tool}	${session.transcriptPath}
`;
}
function formatSkillWorkOnTaskResult(session, task, databasePath) {
  if (!session.taskId) {
    return formatSessionSummary(session);
  }
  return [
    formatSessionSummary(session).trimEnd(),
    `taskDocsDir: ${resolveTaskDocsDir(databasePath, task.slug)}`,
    ""
  ].join("\n");
}
function formatTaskDocSummary(taskRef, doc) {
  return `${taskRef}	${doc.path}
`;
}
function formatReEntryManifest(manifest) {
  const lines = [
    "task:",
    `  id: ${manifest.task.id}`,
    `  title: ${manifest.task.title}`,
    ...manifest.task.description ? [`  description: ${manifest.task.description}`] : [],
    `  projectRoot: ${manifest.task.projectRoot}`
  ];
  if (manifest.state) {
    lines.push("state:", `  path: ${manifest.state.path}`);
  }
  lines.push(`taskDocsDir: ${manifest.taskDocsDir}`);
  if (manifest.docs.length === 0) {
    lines.push("docs: []");
  } else {
    lines.push("docs:", ...manifest.docs.map((doc) => `- path: ${doc.path}`));
  }
  if (manifest.sessions.length === 0) {
    lines.push("sessions: []");
  } else {
    lines.push(
      "sessions:",
      ...manifest.sessions.flatMap((session) => [
        `- id: ${session.id}`,
        `  tool: ${session.tool}`,
        `  transcript: ${session.transcriptPath}`,
        `  mostRecent: ${session.isMostRecent ? "true" : "false"}`,
        ...session.model ? [`  model: ${session.model}`] : []
      ])
    );
  }
  return [...lines, ""].join("\n");
}
function parseSessionRegisterArgs(args) {
  let id;
  let transcriptPath;
  let tool;
  let model;
  const tokenTotals = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || !value) {
      throw new Error(
        "Session register requires --id, --transcript, and --tool"
      );
    }
    if (flag === "--id") {
      id = value;
    } else if (flag === "--transcript") {
      transcriptPath = value;
    } else if (flag === "--tool") {
      tool = value;
    } else if (flag === "--model") {
      model = value;
    } else if (flag === "--input-tokens") {
      tokenTotals.inputTokens = parseNonNegativeInteger(value, flag);
    } else if (flag === "--output-tokens") {
      tokenTotals.outputTokens = parseNonNegativeInteger(value, flag);
    } else if (flag === "--cache-creation-input-tokens") {
      tokenTotals.cacheCreationInputTokens = parseNonNegativeInteger(
        value,
        flag
      );
    } else if (flag === "--cache-read-input-tokens") {
      tokenTotals.cacheReadInputTokens = parseNonNegativeInteger(value, flag);
    } else if (flag === "--total-tokens") {
      tokenTotals.totalTokens = parseNonNegativeInteger(value, flag);
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }
  if (!id || !transcriptPath || !tool) {
    throw new Error("Session register requires --id, --transcript, and --tool");
  }
  if (tool !== "claude" && tool !== "codex") {
    throw new Error("Session tool must be claude or codex");
  }
  return { id, transcriptPath, tool, model, tokenTotals };
}
function parseNonNegativeInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return parsed;
}
function sessionActiveTaskUsage() {
  return "Usage: trace session active-task --id <session-id> [--project <dir>]";
}
function parseSessionActiveTaskArgs(args) {
  let id;
  let project;
  let index = 0;
  while (index < args.length) {
    const flag = args[index];
    if (flag === "--id") {
      const value = args[index + 1];
      if (!value) throw new Error(sessionActiveTaskUsage());
      id = value;
      index += 2;
    } else if (flag === "--project") {
      const value = args[index + 1];
      if (!value) throw new Error(sessionActiveTaskUsage());
      project = value;
      index += 2;
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }
  if (!id) {
    throw new Error(sessionActiveTaskUsage());
  }
  return { id, project };
}
function formatActiveTask(activeTask) {
  if (activeTask.kind === "none") {
    return { kind: "none" };
  }
  return {
    kind: activeTask.kind,
    task: { title: activeTask.task.title, slug: activeTask.task.slug }
  };
}
function parseCodexScanArgs(args, env) {
  let codexHome = env.CODEX_HOME;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || !value) {
      throw new Error("Codex scan accepts --codex-home <path>");
    }
    if (flag === "--codex-home") {
      codexHome = value;
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }
  if (codexHome) {
    return codexHome;
  }
  if (!env.HOME) {
    throw new Error("Codex scan requires --codex-home when HOME is not set");
  }
  return `${env.HOME}/.codex`;
}
function parseClaudeScanArgs(args, env) {
  let projectsRoot;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || !value) {
      throw new Error("Claude scan accepts --projects-root <path>");
    }
    if (flag === "--projects-root") {
      projectsRoot = value;
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }
  if (projectsRoot) {
    return projectsRoot;
  }
  if (!env.HOME) {
    throw new Error(
      "Claude scan requires --projects-root when HOME is not set"
    );
  }
  return `${env.HOME}/.claude/projects`;
}
function parseSessionTailLimit(args) {
  if (args.length === 0) {
    return void 0;
  }
  if (args.length !== 2 || args[0] !== "--limit") {
    throw new Error("Session tail accepts --limit <count>");
  }
  return parseNonNegativeInteger(args[1] ?? "", "--limit");
}
function parseSkillWorkOnTaskArgs(args, env) {
  let id;
  let transcriptPath;
  let tool;
  let model;
  let description;
  let project;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || !value) {
      throw new Error(
        "Skill work-on-task accepts --id, --transcript, --tool, --model, --description, and --project"
      );
    }
    if (flag === "--id") {
      id = value;
    } else if (flag === "--transcript") {
      transcriptPath = value;
    } else if (flag === "--tool") {
      tool = value;
    } else if (flag === "--model") {
      model = value;
    } else if (flag === "--description") {
      description = value;
    } else if (flag === "--project") {
      project = value;
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }
  let toolOverride;
  if (tool === void 0) {
    toolOverride = void 0;
  } else if (tool === "claude" || tool === "codex") {
    toolOverride = tool;
  } else {
    throw new Error("Session tool must be claude or codex");
  }
  const identity = inferSessionIdentity(env, {
    tool: toolOverride,
    id,
    transcriptPath
  });
  if (identity.id === void 0 || identity.transcriptPath === void 0) {
    throw new Error(
      "Skill work-on-task requires --id or a current session env var"
    );
  }
  return {
    id: identity.id,
    transcriptPath: identity.transcriptPath,
    tool: identity.tool,
    model,
    tokenTotals: {},
    description,
    project
  };
}
var invokedPath = process.argv[1];
var modulePath = fileURLToPath3(import.meta.url);
var isTraceEntry = basename3(modulePath) === "trace.ts" || basename3(modulePath) === "trace.js";
var isDirectRun = invokedPath !== void 0 && isTraceEntry && safeRealpath(invokedPath) === modulePath;
function safeRealpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
if (isDirectRun) {
  const result = runTraceCli(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
export {
  runTraceCli
};
