import { sql } from "drizzle-orm";
import { SESSION_TOOLS } from "./types.ts";
import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: text("created_at").notNull(),
  projectRoot: text("project_root").notNull().default(""),
  archivedAt: text("archived_at"),
  description: text("description"),
  pinnedAt: text("pinned_at"),
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
