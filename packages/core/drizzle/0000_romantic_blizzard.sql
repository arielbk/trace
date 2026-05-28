CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`transcript_path` text NOT NULL,
	`tool` text NOT NULL,
	`task_id` text,
	`created_at` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_creation_input_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_input_tokens` integer DEFAULT 0 NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `task_docs` (
	`task_id` text NOT NULL,
	`path` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`task_id`, `path`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`created_at` text NOT NULL
);
