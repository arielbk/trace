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
  ],
} as const;

export const migrationSqlByTag: Record<string, string> = {
  "0000_romantic_blizzard":
    "CREATE TABLE `sessions` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`transcript_path` text NOT NULL,\n\t`tool` text NOT NULL,\n\t`task_id` text,\n\t`created_at` text NOT NULL,\n\t`input_tokens` integer DEFAULT 0 NOT NULL,\n\t`output_tokens` integer DEFAULT 0 NOT NULL,\n\t`cache_creation_input_tokens` integer DEFAULT 0 NOT NULL,\n\t`cache_read_input_tokens` integer DEFAULT 0 NOT NULL,\n\t`total_tokens` integer DEFAULT 0 NOT NULL,\n\tFOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null\n);\n--> statement-breakpoint\nCREATE TABLE `task_docs` (\n\t`task_id` text NOT NULL,\n\t`path` text NOT NULL,\n\t`created_at` text NOT NULL,\n\tPRIMARY KEY(`task_id`, `path`),\n\tFOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade\n);\n--> statement-breakpoint\nCREATE TABLE `tasks` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`title` text NOT NULL,\n\t`created_at` text NOT NULL\n);\n",
  "0001_task_project_root":
    "ALTER TABLE `tasks` ADD `project_root` text DEFAULT '' NOT NULL;\n",
  "0002_session_model": "ALTER TABLE `sessions` ADD `model` text;\n",
};
