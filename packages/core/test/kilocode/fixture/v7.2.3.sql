-- Exact schema migration SQL from v7.2.3, followed by a compatibility journal for the current runner.
-- 20260127222353_familiar_lady_ursula
CREATE TABLE `project` (
	`id` text PRIMARY KEY,
	`worktree` text NOT NULL,
	`vcs` text,
	`name` text,
	`icon_url` text,
	`icon_color` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`time_initialized` integer,
	`sandboxes` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `message` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT `fk_message_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `part` (
	`id` text PRIMARY KEY,
	`message_id` text NOT NULL,
	`session_id` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT `fk_part_message_id_message_id_fk` FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `permission` (
	`project_id` text PRIMARY KEY,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT `fk_permission_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`parent_id` text,
	`slug` text NOT NULL,
	`directory` text NOT NULL,
	`title` text NOT NULL,
	`version` text NOT NULL,
	`share_url` text,
	`summary_additions` integer,
	`summary_deletions` integer,
	`summary_files` integer,
	`summary_diffs` text,
	`revert` text,
	`permission` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`time_compacting` integer,
	`time_archived` integer,
	CONSTRAINT `fk_session_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `todo` (
	`session_id` text NOT NULL,
	`content` text NOT NULL,
	`status` text NOT NULL,
	`priority` text NOT NULL,
	`position` integer NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `todo_pk` PRIMARY KEY(`session_id`, `position`),
	CONSTRAINT `fk_todo_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `session_share` (
	`session_id` text PRIMARY KEY,
	`id` text NOT NULL,
	`secret` text NOT NULL,
	`url` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_session_share_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `message_session_idx` ON `message` (`session_id`);--> statement-breakpoint
CREATE INDEX `part_message_idx` ON `part` (`message_id`);--> statement-breakpoint
CREATE INDEX `part_session_idx` ON `part` (`session_id`);--> statement-breakpoint
CREATE INDEX `session_project_idx` ON `session` (`project_id`);--> statement-breakpoint
CREATE INDEX `session_parent_idx` ON `session` (`parent_id`);--> statement-breakpoint
CREATE INDEX `todo_session_idx` ON `todo` (`session_id`);
-- 20260211171708_add_project_commands
ALTER TABLE `project` ADD `commands` text;
-- 20260213144116_wakeful_the_professor
CREATE TABLE `control_account` (
	`email` text NOT NULL,
	`url` text NOT NULL,
	`access_token` text NOT NULL,
	`refresh_token` text NOT NULL,
	`token_expiry` integer,
	`active` integer NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `control_account_pk` PRIMARY KEY(`email`, `url`)
);
-- 20260225215848_workspace
CREATE TABLE `workspace` (
	`id` text PRIMARY KEY,
	`branch` text,
	`project_id` text NOT NULL,
	`config` text NOT NULL,
	CONSTRAINT `fk_workspace_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);
-- 20260227213759_add_session_workspace_id
ALTER TABLE `session` ADD `workspace_id` text;--> statement-breakpoint
CREATE INDEX `session_workspace_idx` ON `session` (`workspace_id`);
-- 20260303231226_add_workspace_fields
ALTER TABLE `workspace` ADD `type` text NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace` ADD `name` text;--> statement-breakpoint
ALTER TABLE `workspace` ADD `directory` text;--> statement-breakpoint
ALTER TABLE `workspace` ADD `extra` text;--> statement-breakpoint
ALTER TABLE `workspace` DROP COLUMN `config`;
CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL);
INSERT INTO migration (id,time_completed) VALUES ('20260127222353_familiar_lady_ursula',0);
INSERT INTO migration (id,time_completed) VALUES ('20260211171708_add_project_commands',0);
INSERT INTO migration (id,time_completed) VALUES ('20260213144116_wakeful_the_professor',0);
INSERT INTO migration (id,time_completed) VALUES ('20260225215848_workspace',0);
INSERT INTO migration (id,time_completed) VALUES ('20260227213759_add_session_workspace_id',0);
INSERT INTO migration (id,time_completed) VALUES ('20260303231226_add_workspace_fields',0);
PRAGMA foreign_keys=ON;
