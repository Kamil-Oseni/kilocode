-- Generated from git tag v7.4.15, commit 13e425966261e159e915903df5a9e54792a0c657. Do not hand-edit.
PRAGMA foreign_keys=OFF;
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
-- 20260228203230_blue_harpoon
CREATE TABLE `account` (
	`id` text PRIMARY KEY,
	`email` text NOT NULL,
	`url` text NOT NULL,
	`access_token` text NOT NULL,
	`refresh_token` text NOT NULL,
	`token_expiry` integer,
	`selected_org_id` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `account_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`active_account_id` text,
	FOREIGN KEY (`active_account_id`) REFERENCES `account`(`id`) ON UPDATE no action ON DELETE set null
);
-- 20260303231226_add_workspace_fields
ALTER TABLE `workspace` ADD `type` text NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace` ADD `name` text;--> statement-breakpoint
ALTER TABLE `workspace` ADD `directory` text;--> statement-breakpoint
ALTER TABLE `workspace` ADD `extra` text;--> statement-breakpoint
ALTER TABLE `workspace` DROP COLUMN `config`;
-- 20260309230000_move_org_to_state
ALTER TABLE `account_state` ADD `active_org_id` text;--> statement-breakpoint
UPDATE `account_state` SET `active_org_id` = (SELECT `selected_org_id` FROM `account` WHERE `account`.`id` = `account_state`.`active_account_id`);--> statement-breakpoint
ALTER TABLE `account` DROP COLUMN `selected_org_id`;
-- 20260312043431_session_message_cursor
DROP INDEX IF EXISTS `message_session_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `part_message_idx`;--> statement-breakpoint
CREATE INDEX `message_session_time_created_id_idx` ON `message` (`session_id`,`time_created`,`id`);--> statement-breakpoint
CREATE INDEX `part_message_id_id_idx` ON `part` (`message_id`,`id`);
-- 20260323234822_events
CREATE TABLE `event_sequence` (
	`aggregate_id` text PRIMARY KEY,
	`seq` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `event` (
	`id` text PRIMARY KEY,
	`aggregate_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT `fk_event_aggregate_id_event_sequence_aggregate_id_fk` FOREIGN KEY (`aggregate_id`) REFERENCES `event_sequence`(`aggregate_id`) ON DELETE CASCADE
);
-- 20260410174513_workspace-name
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_workspace` (
	`id` text PRIMARY KEY,
	`type` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`branch` text,
	`directory` text,
	`extra` text,
	`project_id` text NOT NULL,
	CONSTRAINT `fk_workspace_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `__new_workspace`(`id`, `type`, `branch`, `name`, `directory`, `extra`, `project_id`) SELECT `id`, `type`, `branch`, `name`, `directory`, `extra`, `project_id` FROM `workspace`;--> statement-breakpoint
DROP TABLE `workspace`;--> statement-breakpoint
ALTER TABLE `__new_workspace` RENAME TO `workspace`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
-- 20260413175956_chief_energizer
CREATE TABLE `session_entry` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`type` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT `fk_session_entry_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `session_entry_session_idx` ON `session_entry` (`session_id`);--> statement-breakpoint
CREATE INDEX `session_entry_session_type_idx` ON `session_entry` (`session_id`,`type`);--> statement-breakpoint
CREATE INDEX `session_entry_time_created_idx` ON `session_entry` (`time_created`);
-- 20260423070820_add_icon_url_override
ALTER TABLE `project` ADD `icon_url_override` text;
UPDATE `project` SET `icon_url_override` = `icon_url` WHERE `icon_url` IS NOT NULL;
-- 20260427172553_slow_nightmare
CREATE TABLE `session_message` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`type` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT `fk_session_message_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
DROP INDEX IF EXISTS `session_entry_session_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `session_entry_session_type_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `session_entry_time_created_idx`;--> statement-breakpoint
CREATE INDEX `session_message_session_idx` ON `session_message` (`session_id`);--> statement-breakpoint
CREATE INDEX `session_message_session_type_idx` ON `session_message` (`session_id`,`type`);--> statement-breakpoint
CREATE INDEX `session_message_time_created_idx` ON `session_message` (`time_created`);--> statement-breakpoint
DROP TABLE `session_entry`;
-- 20260428004200_add_session_path
ALTER TABLE `session` ADD `path` text;
-- 20260501142318_next_venus
ALTER TABLE `session` ADD `agent` text;--> statement-breakpoint
ALTER TABLE `session` ADD `model` text;
-- 20260504145000_add_sync_owner
ALTER TABLE `event_sequence` ADD `owner_id` text;
-- 20260507164347_add_workspace_time
ALTER TABLE `workspace` ADD `time_used` integer NOT NULL DEFAULT 0;
-- 20260510033149_session_usage
ALTER TABLE `session` ADD `cost` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session` ADD `tokens_input` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session` ADD `tokens_output` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session` ADD `tokens_reasoning` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session` ADD `tokens_cache_read` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session` ADD `tokens_cache_write` integer DEFAULT 0 NOT NULL;
-- 20260511000411_data_migration_state
CREATE TABLE `data_migration` (
	`name` text PRIMARY KEY,
	`time_completed` integer NOT NULL
);
-- 20260511173437_session-metadata
ALTER TABLE `session` ADD `metadata` text;
-- 20260601010001_normalize_storage_paths
UPDATE project SET worktree = REPLACE(worktree, char(92), '/') WHERE worktree GLOB '[A-Za-z]:' || char(92) || '*' OR worktree LIKE char(92) || char(92) || '%';
--> statement-breakpoint
UPDATE project SET sandboxes = REPLACE(sandboxes, char(92) || char(92), '/') WHERE instr(sandboxes, char(92)) > 0 AND (worktree GLOB '[A-Za-z]:*' OR worktree LIKE '//%');
--> statement-breakpoint
UPDATE session SET directory = REPLACE(directory, char(92), '/') WHERE directory GLOB '[A-Za-z]:' || char(92) || '*' OR directory LIKE char(92) || char(92) || '%';
--> statement-breakpoint
UPDATE session SET path = REPLACE(path, char(92), '/') WHERE path IS NOT NULL AND instr(path, char(92)) > 0 AND (directory GLOB '[A-Za-z]:*' OR directory LIKE '//%');
-- 20260601202201_amazing_prowler
DROP TABLE `permission`;
-- 20260602002951_lowly_union_jack
CREATE TABLE `permission` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`action` text NOT NULL,
	`resource` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_permission_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `permission_project_action_resource_idx` ON `permission` (`project_id`,`action`,`resource`);
-- 20260602182828_add_project_directories
CREATE TABLE `project_directory` (
	`project_id` text NOT NULL,
	`directory` text NOT NULL,
	`type` text NOT NULL,
	`time_created` integer NOT NULL,
	CONSTRAINT `project_directory_pk` PRIMARY KEY(`project_id`, `directory`),
	CONSTRAINT `fk_project_directory_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);
-- 20260603001617_session_message_projection_indexes
DROP INDEX IF EXISTS `session_message_session_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `session_message_session_type_idx`;--> statement-breakpoint
CREATE INDEX `event_aggregate_seq_idx` ON `event` (`aggregate_id`,`seq`);--> statement-breakpoint
CREATE INDEX `session_message_session_time_created_id_idx` ON `session_message` (`session_id`,`time_created`,`id`);--> statement-breakpoint
CREATE INDEX `session_message_session_type_time_created_id_idx` ON `session_message` (`session_id`,`type`,`time_created`,`id`);
-- 20260603040000_session_message_projection_order
DELETE FROM `session_message`;--> statement-breakpoint
-- kilocode_change
ALTER TABLE `session_message` ADD `seq` integer;--> statement-breakpoint
DROP INDEX IF EXISTS `session_message_session_time_created_id_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `session_message_session_type_time_created_id_idx`;--> statement-breakpoint
CREATE INDEX `session_message_session_seq_idx` ON `session_message` (`session_id`,`seq`);--> statement-breakpoint
CREATE INDEX `session_message_session_type_seq_idx` ON `session_message` (`session_id`,`type`,`seq`);
-- 20260603141458_session_input_inbox
CREATE TABLE `session_input` (
	`seq` integer PRIMARY KEY AUTOINCREMENT,
	`id` text NOT NULL UNIQUE,
	`session_id` text NOT NULL,
	`prompt` text NOT NULL,
	`delivery` text NOT NULL,
	`promoted_seq` integer,
	`time_created` integer NOT NULL,
	CONSTRAINT `fk_session_input_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `session_input_session_pending_seq_idx` ON `session_input` (`session_id`,`promoted_seq`,`seq`);
-- 20260603160727_jittery_ezekiel_stane
DROP INDEX IF EXISTS `session_input_session_pending_seq_idx`;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `event_aggregate_type_seq_idx` ON `event` (`aggregate_id`,`type`,`seq`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `session_input_session_pending_delivery_seq_idx` ON `session_input` (`session_id`,`promoted_seq`,`delivery`,`seq`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `session_message_session_time_created_id_idx` ON `session_message` (`session_id`,`time_created`,`id`);
-- 20260604172448_event_sourced_session_input
DELETE FROM `session_input`;--> statement-breakpoint
DELETE FROM `session_message`;--> statement-breakpoint
DELETE FROM `event`;--> statement-breakpoint
DELETE FROM `event_sequence`;--> statement-breakpoint
UPDATE `session` SET `workspace_id` = NULL;--> statement-breakpoint
DELETE FROM `workspace`;--> statement-breakpoint
DROP INDEX IF EXISTS `event_aggregate_seq_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `event_aggregate_seq_idx` ON `event` (`aggregate_id`,`seq`);--> statement-breakpoint
DROP INDEX IF EXISTS `session_message_session_seq_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `session_message_session_seq_idx` ON `session_message` (`session_id`,`seq`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_session_input` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`prompt` text NOT NULL,
	`delivery` text NOT NULL,
	`admitted_seq` integer NOT NULL,
	`promoted_seq` integer,
	`time_created` integer NOT NULL,
	CONSTRAINT `fk_session_input_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
DROP TABLE `session_input`;--> statement-breakpoint
ALTER TABLE `__new_session_input` RENAME TO `session_input`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `session_input_session_pending_delivery_seq_idx` ON `session_input` (`session_id`,`promoted_seq`,`delivery`,`admitted_seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_input_session_admitted_seq_idx` ON `session_input` (`session_id`,`admitted_seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_input_session_promoted_seq_idx` ON `session_input` (`session_id`,`promoted_seq`);
-- 20260605003541_add_session_context_snapshot
CREATE TABLE `session_context_epoch` (
	`session_id` text PRIMARY KEY,
	`baseline` text NOT NULL,
	`snapshot` text NOT NULL,
	`baseline_seq` integer NOT NULL,
	`replacement_seq` integer,
	`revision` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `fk_session_context_epoch_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
-- 20260605042240_add_context_epoch_agent
ALTER TABLE `session_context_epoch` ADD `agent` text DEFAULT 'build' NOT NULL;
-- 20260611035744_credential
CREATE TABLE `credential` (
	`id` text PRIMARY KEY,
	`connector_id` text NOT NULL,
	`method_id` text NOT NULL,
	`label` text NOT NULL,
	`value` text NOT NULL,
	`active` integer DEFAULT false NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credential_connector_active_idx` ON `credential` (`connector_id`) WHERE "credential"."active" = 1;
-- 20260714141136_session-message-legacy-writer-compat
-- kilocode_change - new file
CREATE TABLE `__new_session_message` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`type` text NOT NULL,
	`seq` integer,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT `fk_session_message_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `__new_session_message`(`id`, `session_id`, `type`, `seq`, `time_created`, `time_updated`, `data`) SELECT `id`, `session_id`, `type`, `seq`, `time_created`, `time_updated`, `data` FROM `session_message`;--> statement-breakpoint
DROP TABLE `session_message`;--> statement-breakpoint
ALTER TABLE `__new_session_message` RENAME TO `session_message`;--> statement-breakpoint
CREATE UNIQUE INDEX `session_message_session_seq_idx` ON `session_message` (`session_id`,`seq`);--> statement-breakpoint
CREATE INDEX `session_message_session_type_seq_idx` ON `session_message` (`session_id`,`type`,`seq`);--> statement-breakpoint
CREATE INDEX `session_message_session_time_created_id_idx` ON `session_message` (`session_id`,`time_created`,`id`);--> statement-breakpoint
CREATE INDEX `session_message_time_created_idx` ON `session_message` (`time_created`);
CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL);
INSERT INTO migration (id,time_completed) VALUES ('20260127222353_familiar_lady_ursula',0);
INSERT INTO migration (id,time_completed) VALUES ('20260211171708_add_project_commands',0);
INSERT INTO migration (id,time_completed) VALUES ('20260213144116_wakeful_the_professor',0);
INSERT INTO migration (id,time_completed) VALUES ('20260225215848_workspace',0);
INSERT INTO migration (id,time_completed) VALUES ('20260227213759_add_session_workspace_id',0);
INSERT INTO migration (id,time_completed) VALUES ('20260228203230_blue_harpoon',0);
INSERT INTO migration (id,time_completed) VALUES ('20260303231226_add_workspace_fields',0);
INSERT INTO migration (id,time_completed) VALUES ('20260309230000_move_org_to_state',0);
INSERT INTO migration (id,time_completed) VALUES ('20260312043431_session_message_cursor',0);
INSERT INTO migration (id,time_completed) VALUES ('20260323234822_events',0);
INSERT INTO migration (id,time_completed) VALUES ('20260410174513_workspace-name',0);
INSERT INTO migration (id,time_completed) VALUES ('20260413175956_chief_energizer',0);
INSERT INTO migration (id,time_completed) VALUES ('20260423070820_add_icon_url_override',0);
INSERT INTO migration (id,time_completed) VALUES ('20260427172553_slow_nightmare',0);
INSERT INTO migration (id,time_completed) VALUES ('20260428004200_add_session_path',0);
INSERT INTO migration (id,time_completed) VALUES ('20260501142318_next_venus',0);
INSERT INTO migration (id,time_completed) VALUES ('20260504145000_add_sync_owner',0);
INSERT INTO migration (id,time_completed) VALUES ('20260507164347_add_workspace_time',0);
INSERT INTO migration (id,time_completed) VALUES ('20260510033149_session_usage',0);
INSERT INTO migration (id,time_completed) VALUES ('20260511000411_data_migration_state',0);
INSERT INTO migration (id,time_completed) VALUES ('20260511173437_session-metadata',0);
INSERT INTO migration (id,time_completed) VALUES ('20260601010001_normalize_storage_paths',0);
INSERT INTO migration (id,time_completed) VALUES ('20260601202201_amazing_prowler',0);
INSERT INTO migration (id,time_completed) VALUES ('20260602002951_lowly_union_jack',0);
INSERT INTO migration (id,time_completed) VALUES ('20260602182828_add_project_directories',0);
INSERT INTO migration (id,time_completed) VALUES ('20260603001617_session_message_projection_indexes',0);
INSERT INTO migration (id,time_completed) VALUES ('20260603040000_session_message_projection_order',0);
INSERT INTO migration (id,time_completed) VALUES ('20260603141458_session_input_inbox',0);
INSERT INTO migration (id,time_completed) VALUES ('20260603160727_jittery_ezekiel_stane',0);
INSERT INTO migration (id,time_completed) VALUES ('20260604172448_event_sourced_session_input',0);
INSERT INTO migration (id,time_completed) VALUES ('20260605003541_add_session_context_snapshot',0);
INSERT INTO migration (id,time_completed) VALUES ('20260605042240_add_context_epoch_agent',0);
INSERT INTO migration (id,time_completed) VALUES ('20260611035744_credential',0);
INSERT INTO migration (id,time_completed) VALUES ('20260714141136_session-message-legacy-writer-compat',0);
PRAGMA foreign_keys=ON;
