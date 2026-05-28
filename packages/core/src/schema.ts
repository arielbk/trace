import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  primaryKey,
} from "drizzle-orm/sqlite-core";

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  createdAt: text("created_at").notNull(),
  projectRoot: text("project_root").notNull().default(""),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  transcriptPath: text("transcript_path").notNull(),
  tool: text("tool", { enum: ["claude", "codex"] }).notNull(),
  model: text("model"),
  taskId: text("task_id").references(() => tasks.id, { onDelete: "set null" }),
  createdAt: text("created_at").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cacheCreationInputTokens: integer("cache_creation_input_tokens")
    .notNull()
    .default(0),
  cacheReadInputTokens: integer("cache_read_input_tokens").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
});

export const taskDocs = sqliteTable(
  "task_docs",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.taskId, table.path] })],
);

export { sql };
