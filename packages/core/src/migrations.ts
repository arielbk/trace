export const migrationJournal = {
  entries: [
    {
      when: 1779991399241,
      tag: "0000_romantic_blizzard",
      breakpoints: true,
    },
    {
      when: 1779999700000,
      tag: "0001_task_project_root",
      breakpoints: false,
    },
    {
      when: 1780019700000,
      tag: "0002_session_model",
      breakpoints: false,
    },
    {
      when: 1780099700000,
      tag: "0003_task_slug",
      breakpoints: true,
    },
    {
      when: 1780119700000,
      tag: "0004_task_archive",
      breakpoints: false,
    },
    {
      when: 1780139700000,
      tag: "0005_task_description",
      breakpoints: false,
    },
    {
      when: 1780159700000,
      tag: "0006_task_doc_description",
      breakpoints: false,
    },
    {
      when: 1780179700000,
      tag: "0007_session_parent_attribution",
      breakpoints: true,
    },
    {
      when: 1780199700000,
      tag: "0008_session_title",
      breakpoints: false,
    },
    {
      when: 1780219700000,
      tag: "0009_task_doc_title",
      breakpoints: false,
    },
    {
      when: 1780239700000,
      tag: "0010_session_context_tokens",
      breakpoints: true,
    },
  ],
} as const;

export const migrationSqlByTag: Record<string, string> = {
  "0000_romantic_blizzard":
    "CREATE TABLE `sessions` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`transcript_path` text NOT NULL,\n\t`tool` text NOT NULL,\n\t`task_id` text,\n\t`created_at` text NOT NULL,\n\t`input_tokens` integer DEFAULT 0 NOT NULL,\n\t`output_tokens` integer DEFAULT 0 NOT NULL,\n\t`cache_creation_input_tokens` integer DEFAULT 0 NOT NULL,\n\t`cache_read_input_tokens` integer DEFAULT 0 NOT NULL,\n\t`total_tokens` integer DEFAULT 0 NOT NULL,\n\tFOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null\n);\n--> statement-breakpoint\nCREATE TABLE `task_docs` (\n\t`task_id` text NOT NULL,\n\t`path` text NOT NULL,\n\t`created_at` text NOT NULL,\n\tPRIMARY KEY(`task_id`, `path`),\n\tFOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade\n);\n--> statement-breakpoint\nCREATE TABLE `tasks` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`title` text NOT NULL,\n\t`created_at` text NOT NULL\n);\n",
  "0001_task_project_root":
    "ALTER TABLE `tasks` ADD `project_root` text DEFAULT '' NOT NULL;\n",
  "0002_session_model": "ALTER TABLE `sessions` ADD `model` text;\n",
  // The slug column lands nullable so existing rows survive the ALTER; the store
  // backfills slugs immediately after migrations run, then the unique index
  // guards uniqueness for backfilled and freshly created tasks alike.
  "0003_task_slug":
    "ALTER TABLE `tasks` ADD `slug` text;\n--> statement-breakpoint\nCREATE UNIQUE INDEX `tasks_slug_unique` ON `tasks` (`slug`);\n",
  "0004_task_archive": "ALTER TABLE `tasks` ADD `archived_at` text;\n",
  "0005_task_description": "ALTER TABLE `tasks` ADD `description` text;\n",
  "0006_task_doc_description":
    "ALTER TABLE `task_docs` ADD `description` text;\n",
  "0007_session_parent_attribution":
    "ALTER TABLE `sessions` ADD `parent_session_id` text REFERENCES `sessions`(`id`) ON DELETE set null;\n--> statement-breakpoint\nALTER TABLE `sessions` ADD `origin` text DEFAULT 'root' NOT NULL;\n--> statement-breakpoint\nALTER TABLE `sessions` ADD `subagent_type` text;\n--> statement-breakpoint\nALTER TABLE `sessions` ADD `agent_id` text;\n",
  "0008_session_title": "ALTER TABLE `sessions` ADD `title` text;\n",
  "0009_task_doc_title": "ALTER TABLE `task_docs` ADD `title` text;\n",
  "0010_session_context_tokens":
    "ALTER TABLE `sessions` ADD `context_tokens_used` integer;\n--> statement-breakpoint\nALTER TABLE `sessions` ADD `context_tokens_limit` integer;\n",
};
