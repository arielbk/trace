import { sql } from "drizzle-orm";
import { SESSION_TOOLS } from "./types.ts";
import {
  sqliteTable,
  text,
  integer,
  index,
  primaryKey,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    remoteUrl: text("remote_url"),
    rootCommit: text("root_commit"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("projects_remote_url_index").on(table.remoteUrl),
    index("projects_root_commit_index").on(table.rootCommit),
  ],
);

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: text("created_at").notNull(),
  projectRoot: text("project_root").notNull().default(""),
  projectId: text("project_id").references(() => projects.id, {
    onDelete: "restrict",
  }),
  archivedAt: text("archived_at"),
  description: text("description"),
  pinnedAt: text("pinned_at"),
  updatedAt: text("updated_at").notNull(),
  machineId: text("machine_id").notNull(),
});

export const projectRoots = sqliteTable("project_roots", {
  rootPath: text("root_path").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull(),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  transcriptPath: text("transcript_path").notNull(),
  tool: text("tool", { enum: SESSION_TOOLS }).notNull(),
  model: text("model"),
  title: text("title"),
  taskId: text("task_id").references(() => tasks.id, { onDelete: "set null" }),
  parentSessionId: text("parent_session_id").references(
    (): AnySQLiteColumn => sessions.id,
    { onDelete: "set null" },
  ),
  origin: text("origin", { enum: ["root", "subagent", "spawned"] })
    .notNull()
    .default("root"),
  subagentType: text("subagent_type"),
  agentId: text("agent_id"),
  createdAt: text("created_at").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cacheCreationInputTokens: integer("cache_creation_input_tokens")
    .notNull()
    .default(0),
  cacheReadInputTokens: integer("cache_read_input_tokens").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  // Context-window occupancy snapshot. Cursor reports it only for the live
  // composer, so it is persisted at refresh rather than re-derived on read;
  // null means it was never observed (distinct from 0 used).
  contextTokensUsed: integer("context_tokens_used"),
  contextTokensLimit: integer("context_tokens_limit"),
  updatedAt: text("updated_at").notNull(),
  machineId: text("machine_id").notNull(),
});

export const taskDocs = sqliteTable(
  "task_docs",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    createdAt: text("created_at").notNull(),
    title: text("title"),
    description: text("description"),
  },
  (table) => [primaryKey({ columns: [table.taskId, table.path] })],
);

export { sql };
