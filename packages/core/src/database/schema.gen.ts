import { Effect } from "effect"
import type { DatabaseMigration } from "./migration"

export default {
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`workspace\` (
          \`id\` text PRIMARY KEY,
          \`type\` text NOT NULL,
          \`name\` text DEFAULT '' NOT NULL,
          \`branch\` text,
          \`directory\` text,
          \`extra\` text,
          \`project_id\` text NOT NULL,
          \`time_used\` integer NOT NULL,
          CONSTRAINT \`fk_workspace_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`data_migration\` (
          \`name\` text PRIMARY KEY,
          \`time_completed\` integer NOT NULL
        );
      `)
      // kilocode_change start
      yield* tx.run(`
        CREATE TABLE \`raya_routine_archive_import\` (
          \`id\` text PRIMARY KEY,
          \`time_completed\` integer NOT NULL
        );
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TABLE \`raya_routine_archive\` (
          \`id\` text PRIMARY KEY,
          \`archived_at\` integer NOT NULL,
          \`definition\` text NOT NULL
        );
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TABLE \`raya_background_outcome\` (
          \`id\` text NOT NULL,
          \`revision\` text NOT NULL,
          \`identity\` text NOT NULL,
          \`identity_sha\` text NOT NULL,
          \`phase\` text NOT NULL,
          \`terminal\` text,
          \`terminal_sha\` text,
          CONSTRAINT \`raya_background_outcome_pk\` PRIMARY KEY(\`id\`, \`revision\`),
          CONSTRAINT "raya_background_outcome_bounds" CHECK(length(CAST("id" AS BLOB)) BETWEEN 1 AND 256 AND length(CAST("revision" AS BLOB)) BETWEEN 1 AND 256 AND length(CAST("identity" AS BLOB)) BETWEEN 1 AND 262144 AND length("identity_sha") = 64 AND "phase" IN ('admitted','terminal','joined') AND (("phase" = 'admitted' AND "terminal" IS NULL AND "terminal_sha" IS NULL) OR ("phase" IN ('terminal','joined') AND "terminal" IS NOT NULL AND "terminal_sha" IS NOT NULL AND length(CAST("terminal" AS BLOB)) BETWEEN 1 AND 262144 AND length("terminal_sha") = 64)))
        );
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TABLE \`raya_composer_control\` (
          \`id\` text PRIMARY KEY,
          \`storage\` text NOT NULL,
          \`database\` text NOT NULL,
          \`generation\` text NOT NULL,
          \`phase\` text NOT NULL,
          \`source\` text,
          \`source_digest\` text NOT NULL,
          \`marker\` text,
          \`marker_digest\` text NOT NULL,
          \`cursor_secret\` text NOT NULL,
          \`content_bytes\` integer NOT NULL,
          \`metadata_bytes\` integer NOT NULL
        );
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TABLE \`raya_composer_draft\` (
          \`sequence\` integer PRIMARY KEY AUTOINCREMENT,
          \`id\` text NOT NULL,
          \`workspace\` text NOT NULL,
          \`project\` text NOT NULL,
          \`box\` text NOT NULL,
          \`record\` text NOT NULL,
          \`content_bytes\` integer NOT NULL,
          \`metadata_bytes\` integer NOT NULL
        );
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TABLE \`raya_contact_destination\` (
          \`id\` text PRIMARY KEY,
          \`source\` text NOT NULL,
          \`channel\` text NOT NULL,
          \`address\` text NOT NULL,
          \`label\` text,
          \`scope\` text NOT NULL,
          \`scope_id\` text NOT NULL,
          \`quiet_start\` integer,
          \`quiet_end\` integer,
          \`timezone\` text,
          \`revision\` integer NOT NULL,
          \`enabled\` integer NOT NULL,
          \`revoked_at\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TABLE \`raya_contact_message\` (
          \`id\` text PRIMARY KEY,
          \`source\` text NOT NULL,
          \`destination_id\` text NOT NULL,
          \`destination_revision\` integer NOT NULL,
          \`agent_id\` text,
          \`organization_id\` text,
          \`session_id\` text,
          \`body\` text NOT NULL,
          \`state\` text NOT NULL,
          \`attempts\` integer NOT NULL,
          \`available_at\` integer NOT NULL,
          \`lease_id\` text,
          \`lease_owner\` text,
          \`lease_until\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_raya_contact_message_destination_id_raya_contact_destination_id_fk\` FOREIGN KEY (\`destination_id\`) REFERENCES \`raya_contact_destination\`(\`id\`)
        );
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TABLE \`raya_contact_receipt\` (
          \`message_id\` text PRIMARY KEY,
          \`status\` text NOT NULL,
          \`code\` text NOT NULL,
          \`provider_ref\` text,
          \`attempts\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_raya_contact_receipt_message_id_raya_contact_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`raya_contact_message\`(\`id\`) ON DELETE CASCADE
        );
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TABLE \`raya_result_notice\` (
          \`session_id\` text NOT NULL,
          \`message_id\` text NOT NULL,
          \`user_id\` text NOT NULL,
          \`job_id\` text NOT NULL,
          \`revision\` text NOT NULL,
          \`call_id\` text NOT NULL,
          \`input_id\` text NOT NULL,
          \`body\` text NOT NULL,
          \`sha\` text NOT NULL,
          CONSTRAINT \`raya_result_notice_pk\` PRIMARY KEY(\`session_id\`, \`message_id\`),
          CONSTRAINT \`fk_raya_result_notice_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT "raya_result_notice_bounds" CHECK(length(CAST("body" AS BLOB)) BETWEEN 1 AND 262144 AND length("sha") = 64 AND length(CAST("session_id" AS BLOB)) BETWEEN 1 AND 256 AND length(CAST("message_id" AS BLOB)) BETWEEN 1 AND 256 AND length(CAST("user_id" AS BLOB)) BETWEEN 1 AND 256 AND length(CAST("job_id" AS BLOB)) BETWEEN 1 AND 256 AND length(CAST("revision" AS BLOB)) BETWEEN 1 AND 256 AND length(CAST("call_id" AS BLOB)) BETWEEN 1 AND 256 AND length(CAST("input_id" AS BLOB)) BETWEEN 1 AND 256)
        );
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TABLE \`raya_routine_effect_attempt\` (
          \`id\` text PRIMARY KEY,
          \`capsule\` text NOT NULL,
          \`generation\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`purpose\` text NOT NULL,
          \`digest\` text NOT NULL,
          \`owner\` text NOT NULL,
          \`state\` text NOT NULL,
          \`receipt\` text,
          CONSTRAINT \`fk_raya_routine_effect_attempt_capsule_raya_routine_effect_capsule_id_fk\` FOREIGN KEY (\`capsule\`) REFERENCES \`raya_routine_effect_capsule\`(\`id\`),
          CONSTRAINT "raya_routine_effect_attempt_bounds" CHECK(length("id") = 32 AND length("capsule") = 32 AND length("generation") = 32 AND length("digest") = 64 AND length("owner") = 64 AND "kind" IN ('model', 'tool', 'mcp', 'browser', 'native') AND length(CAST("purpose" AS BLOB)) BETWEEN 1 AND 256 AND "state" IN ('reserved', 'started', 'settled', 'refused', 'uncertain') AND (("state" = 'settled' AND "receipt" IS NOT NULL AND length("receipt") = 64) OR ("state" <> 'settled' AND "receipt" IS NULL)))
        );
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TABLE \`raya_routine_effect_capsule\` (
          \`id\` text PRIMARY KEY,
          \`participant\` text NOT NULL,
          \`generation\` text NOT NULL,
          \`run\` text NOT NULL,
          \`session\` text NOT NULL,
          \`step\` text NOT NULL,
          \`owner\` text NOT NULL,
          \`projection\` text NOT NULL,
          \`state\` text DEFAULT 'inactive' NOT NULL,
          CONSTRAINT \`fk_raya_routine_effect_capsule_participant_raya_routine_effect_participant_id_fk\` FOREIGN KEY (\`participant\`) REFERENCES \`raya_routine_effect_participant\`(\`id\`),
          CONSTRAINT "raya_routine_effect_capsule_bounds" CHECK(length("id") = 32 AND length("participant") = 32 AND length("generation") = 32 AND length("owner") = 64 AND length("projection") = 64 AND length(CAST("run" AS BLOB)) BETWEEN 1 AND 256 AND length(CAST("session" AS BLOB)) BETWEEN 1 AND 256 AND length(CAST("step" AS BLOB)) BETWEEN 1 AND 256 AND "state" IN ('inactive', 'active', 'revoked', 'retired'))
        );
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TABLE \`raya_routine_effect_membership\` (
          \`capsule\` text NOT NULL,
          \`scope\` text NOT NULL,
          \`generation\` text NOT NULL,
          CONSTRAINT \`raya_routine_effect_membership_pk\` PRIMARY KEY(\`capsule\`, \`scope\`),
          CONSTRAINT \`fk_raya_routine_effect_membership_capsule_raya_routine_effect_capsule_id_fk\` FOREIGN KEY (\`capsule\`) REFERENCES \`raya_routine_effect_capsule\`(\`id\`),
          CONSTRAINT \`fk_raya_routine_effect_membership_scope_raya_routine_effect_scope_id_fk\` FOREIGN KEY (\`scope\`) REFERENCES \`raya_routine_effect_scope\`(\`id\`),
          CONSTRAINT "raya_routine_effect_membership_bounds" CHECK(length("capsule") = 32 AND length("scope") = 64 AND length("generation") = 32)
        );
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TABLE \`raya_routine_effect_participant\` (
          \`id\` text PRIMARY KEY,
          \`profile\` text NOT NULL,
          \`protocol\` text NOT NULL,
          \`cohort\` text NOT NULL,
          \`pid\` integer NOT NULL,
          \`birth\` text NOT NULL,
          \`state\` text DEFAULT 'inactive' NOT NULL,
          CONSTRAINT "raya_routine_effect_participant_bounds" CHECK(length("id") = 32 AND length("profile") = 64 AND length("cohort") = 64 AND length("birth") BETWEEN 1 AND 20 AND "pid" BETWEEN 1 AND 4294967295 AND "protocol" = 'raya.routine.effect.v1' AND "state" IN ('inactive', 'qualified', 'revoked', 'retired'))
        );
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TABLE \`raya_routine_effect_revocation\` (
          \`id\` text PRIMARY KEY,
          \`scope\` text NOT NULL,
          \`generation\` text NOT NULL,
          \`projection\` text NOT NULL,
          \`request\` text NOT NULL,
          \`reason\` text NOT NULL,
          \`state\` text DEFAULT 'requested' NOT NULL,
          CONSTRAINT \`fk_raya_routine_effect_revocation_scope_raya_routine_effect_scope_id_fk\` FOREIGN KEY (\`scope\`) REFERENCES \`raya_routine_effect_scope\`(\`id\`),
          CONSTRAINT "raya_routine_effect_revocation_bounds" CHECK(length("id") = 32 AND length("scope") = 64 AND length("generation") = 32 AND length("projection") = 64 AND length("request") = 64 AND length(CAST("reason" AS BLOB)) BETWEEN 1 AND 256 AND "state" IN ('requested', 'published', 'uncertain'))
        );
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TABLE \`raya_routine_effect_scope\` (
          \`id\` text PRIMARY KEY,
          \`kind\` text NOT NULL,
          \`principal\` text NOT NULL,
          \`birth\` text NOT NULL,
          \`generation\` text NOT NULL,
          \`projection\` text NOT NULL,
          \`state\` text DEFAULT 'inactive' NOT NULL,
          CONSTRAINT "raya_routine_effect_scope_bounds" CHECK(length("id") = 64 AND length("generation") = 32 AND length("projection") = 64 AND length(CAST("principal" AS BLOB)) BETWEEN 1 AND 256 AND length("birth") BETWEEN 1 AND 20 AND "state" IN ('inactive', 'active', 'revoking', 'retired') AND "kind" IN ('principal', 'organization', 'goal', 'run', 'session', 'delegation', 'workspace', 'config'))
        );
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TABLE \`raya_routine_attachment\` (
          \`id\` text PRIMARY KEY,
          \`agent_id\` text NOT NULL,
          \`message_id\` text,
          \`name\` text NOT NULL,
          \`mime\` text NOT NULL,
          \`size\` integer NOT NULL,
          \`data\` text NOT NULL,
          \`sha256\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_raya_routine_attachment_agent_id_raya_routine_conversation_agent_id_fk\` FOREIGN KEY (\`agent_id\`) REFERENCES \`raya_routine_conversation\`(\`agent_id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_raya_routine_attachment_message_id_raya_routine_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`raya_routine_message\`(\`id\`) ON DELETE CASCADE
        );
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TABLE \`raya_routine_conversation\` (
          \`agent_id\` text PRIMARY KEY,
          \`id\` text NOT NULL,
          \`read_at\` integer NOT NULL,
          \`draft\` text,
          \`draft_attachments\` text,
          \`draft_revision\` integer DEFAULT 0 NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TABLE \`raya_routine_cursor\` (
          \`agent_id\` text NOT NULL,
          \`schedule_version\` integer NOT NULL,
          \`through\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`raya_routine_cursor_pk\` PRIMARY KEY(\`agent_id\`, \`schedule_version\`)
        );
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TABLE \`raya_routine_delegation\` (
          \`id\` text PRIMARY KEY,
          \`source\` text NOT NULL,
          \`sender_id\` text NOT NULL,
          \`recipient_id\` text NOT NULL,
          \`parent_id\` text,
          \`parent_run_id\` text,
          \`organization_id\` text,
          \`organization_name\` text,
          \`organization_revision\` integer,
          \`workspace\` text,
          \`objective\` text NOT NULL,
          \`expected\` text,
          \`criteria\` text,
          \`outputs\` text,
          \`context\` text,
          \`deadline\` integer,
          \`budget\` integer,
          \`depth\` integer NOT NULL,
          \`state\` text NOT NULL,
          \`child_run_id\` text,
          \`session_id\` text,
          \`artifacts\` text,
          \`response\` text,
          \`cost\` real,
          \`reason\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TABLE \`raya_routine_message\` (
          \`id\` text PRIMARY KEY,
          \`agent_id\` text NOT NULL,
          \`source\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`body\` text NOT NULL,
          \`occurrence_id\` text,
          \`session_id\` text,
          \`files\` text,
          \`attachments\` text,
          \`delivery_id\` text,
          \`delivered_at\` integer,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_raya_routine_message_agent_id_raya_routine_conversation_agent_id_fk\` FOREIGN KEY (\`agent_id\`) REFERENCES \`raya_routine_conversation\`(\`agent_id\`) ON DELETE CASCADE
        );
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TABLE \`raya_routine_occurrence\` (
          \`id\` text PRIMARY KEY,
          \`agent_id\` text NOT NULL,
          \`schedule_version\` integer NOT NULL,
          \`scheduled_at\` integer NOT NULL,
          \`observed_at\` integer NOT NULL,
          \`timezone\` text,
          \`state\` text NOT NULL,
          \`claim_id\` text,
          \`owner\` text,
          \`lease_until\` integer,
          \`session_id\` text,
          \`reason\` text,
          \`time_updated\` integer NOT NULL
        );
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TABLE \`raya_routine_organization_coordinator\` (
          \`message_id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`organization_id\` text,
          \`organization_revision\` integer,
          \`state\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_raya_routine_organization_coordinator_organization_id_raya_routine_organization_id_fk\` FOREIGN KEY (\`organization_id\`) REFERENCES \`raya_routine_organization\`(\`id\`) ON DELETE CASCADE
        );
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TABLE \`raya_routine_organization_delegation\` (
          \`organization_id\` text NOT NULL,
          \`sender_id\` text NOT NULL,
          \`recipient_id\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`raya_routine_organization_delegation_pk\` PRIMARY KEY(\`organization_id\`, \`sender_id\`, \`recipient_id\`),
          CONSTRAINT \`fk_raya_routine_organization_delegation_organization_id_raya_routine_organization_id_fk\` FOREIGN KEY (\`organization_id\`) REFERENCES \`raya_routine_organization\`(\`id\`) ON DELETE CASCADE
        );
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TABLE \`raya_routine_organization_member\` (
          \`organization_id\` text NOT NULL,
          \`agent_id\` text NOT NULL,
          \`role\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`supervisor_id\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`raya_routine_organization_member_pk\` PRIMARY KEY(\`organization_id\`, \`agent_id\`),
          CONSTRAINT \`fk_raya_routine_organization_member_organization_id_raya_routine_organization_id_fk\` FOREIGN KEY (\`organization_id\`) REFERENCES \`raya_routine_organization\`(\`id\`) ON DELETE CASCADE
        );
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TABLE \`raya_routine_organization_reservation\` (
          \`run_id\` text PRIMARY KEY,
          \`agent_id\` text NOT NULL,
          \`organization_id\` text NOT NULL,
          \`organization_revision\` integer NOT NULL,
          \`session_id\` text,
          \`budget\` real NOT NULL,
          \`cost\` real,
          \`state\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_raya_routine_organization_reservation_organization_id_raya_routine_organization_id_fk\` FOREIGN KEY (\`organization_id\`) REFERENCES \`raya_routine_organization\`(\`id\`) ON DELETE CASCADE
        );
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TABLE \`raya_routine_organization_revision\` (
          \`organization_id\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`definition\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`raya_routine_organization_revision_pk\` PRIMARY KEY(\`organization_id\`, \`revision\`),
          CONSTRAINT \`fk_raya_routine_organization_revision_organization_id_raya_routine_organization_id_fk\` FOREIGN KEY (\`organization_id\`) REFERENCES \`raya_routine_organization\`(\`id\`) ON DELETE CASCADE
        );
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TABLE \`raya_routine_organization\` (
          \`id\` text PRIMARY KEY,
          \`name\` text NOT NULL,
          \`purpose\` text,
          \`policy\` text,
          \`budget\` integer,
          \`revision\` integer NOT NULL,
          \`archived_at\` integer,
          \`stopping_at\` integer,
          \`stopped_at\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TABLE \`raya_voice_binding\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_raya_voice_binding_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      // kilocode_change end
      yield* tx.run(`
        CREATE TABLE \`account_state\` (
          \`id\` integer PRIMARY KEY,
          \`active_account_id\` text,
          \`active_org_id\` text,
          CONSTRAINT \`fk_account_state_active_account_id_account_id_fk\` FOREIGN KEY (\`active_account_id\`) REFERENCES \`account\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`account\` (
          \`id\` text PRIMARY KEY,
          \`email\` text NOT NULL,
          \`url\` text NOT NULL,
          \`access_token\` text NOT NULL,
          \`refresh_token\` text NOT NULL,
          \`token_expiry\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`control_account\` (
          \`email\` text NOT NULL,
          \`url\` text NOT NULL,
          \`access_token\` text NOT NULL,
          \`refresh_token\` text NOT NULL,
          \`token_expiry\` integer,
          \`active\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`control_account_pk\` PRIMARY KEY(\`email\`, \`url\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`credential\` (
          \`id\` text PRIMARY KEY,
          \`integration_id\` text,
          \`label\` text NOT NULL,
          \`value\` text NOT NULL,
          \`connector_id\` text,
          \`method_id\` text,
          \`active\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event_sequence\` (
          \`aggregate_id\` text PRIMARY KEY,
          \`seq\` integer NOT NULL,
          \`owner_id\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event\` (
          \`id\` text PRIMARY KEY,
          \`aggregate_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`type\` text NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_event_aggregate_id_event_sequence_aggregate_id_fk\` FOREIGN KEY (\`aggregate_id\`) REFERENCES \`event_sequence\`(\`aggregate_id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`permission\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`action\` text NOT NULL,
          \`resource\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_permission_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project_directory\` (
          \`project_id\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`type\` text,
          \`strategy\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`project_directory_pk\` PRIMARY KEY(\`project_id\`, \`directory\`),
          CONSTRAINT \`fk_project_directory_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project\` (
          \`id\` text PRIMARY KEY,
          \`worktree\` text NOT NULL,
          \`vcs\` text,
          \`name\` text,
          \`icon_url\` text,
          \`icon_url_override\` text,
          \`icon_color\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_initialized\` integer,
          \`sandboxes\` text NOT NULL,
          \`commands\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`part\` (
          \`id\` text PRIMARY KEY,
          \`message_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_part_message_id_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`message\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_context_epoch\` (
          \`session_id\` text PRIMARY KEY,
          \`baseline\` text NOT NULL,
          \`snapshot\` text NOT NULL,
          \`baseline_seq\` integer NOT NULL,
          CONSTRAINT \`fk_session_context_epoch_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_input\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`prompt\` text NOT NULL,
          \`delivery\` text NOT NULL,
          \`admitted_seq\` integer NOT NULL,
          \`promoted_seq\` integer,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_input_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`seq\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_session_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`workspace_id\` text,
          \`parent_id\` text,
          \`slug\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`path\` text,
          \`title\` text NOT NULL,
          \`version\` text NOT NULL,
          \`share_url\` text,
          \`summary_additions\` integer,
          \`summary_deletions\` integer,
          \`summary_files\` integer,
          \`summary_diffs\` text,
          \`metadata\` text,
          \`cost\` real DEFAULT 0 NOT NULL,
          \`tokens_input\` integer DEFAULT 0 NOT NULL,
          \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
          \`revert\` text,
          \`permission\` text,
          \`agent\` text,
          \`model\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_compacting\` integer,
          \`time_archived\` integer,
          CONSTRAINT \`fk_session_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`todo\` (
          \`session_id\` text NOT NULL,
          \`content\` text NOT NULL,
          \`status\` text NOT NULL,
          \`priority\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`todo_pk\` PRIMARY KEY(\`session_id\`, \`position\`),
          CONSTRAINT \`fk_todo_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_share\` (
          \`session_id\` text PRIMARY KEY,
          \`id\` text NOT NULL,
          \`secret\` text NOT NULL,
          \`url\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_share_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      // kilocode_change start
      yield* tx.run(
        `CREATE INDEX \`raya_routine_archive_order\` ON \`raya_routine_archive\` ("archived_at" desc,\`id\`);`,
      )
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`CREATE UNIQUE INDEX \`raya_composer_identity\` ON \`raya_composer_draft\` (\`id\`);`)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(
        `CREATE INDEX \`raya_composer_catalog\` ON \`raya_composer_draft\` (\`workspace\`,\`project\`,\`box\`,\`sequence\`);`,
      )
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(
        `CREATE UNIQUE INDEX \`raya_contact_destination_source\` ON \`raya_contact_destination\` (\`source\`);`,
      )
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(
        `CREATE UNIQUE INDEX \`raya_contact_destination_identity\` ON \`raya_contact_destination\` (\`channel\`,\`address\`,\`scope\`,\`scope_id\`);`,
      )
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(
        `CREATE INDEX \`raya_contact_destination_scope\` ON \`raya_contact_destination\` (\`scope\`,\`scope_id\`,\`enabled\`);`,
      )
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`CREATE UNIQUE INDEX \`raya_contact_message_source\` ON \`raya_contact_message\` (\`source\`);`)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(
        `CREATE INDEX \`raya_contact_message_pending\` ON \`raya_contact_message\` (\`state\`,\`available_at\`,\`time_created\`);`,
      )
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(
        `CREATE INDEX \`raya_contact_message_destination\` ON \`raya_contact_message\` (\`destination_id\`,\`state\`,\`time_created\`);`,
      )
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(
        `CREATE INDEX \`raya_result_notice_root_idx\` ON \`raya_result_notice\` (\`session_id\`,\`user_id\`);`,
      )
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(
        `CREATE UNIQUE INDEX \`raya_result_notice_original_idx\` ON \`raya_result_notice\` (\`job_id\`,\`revision\`,\`call_id\`,\`input_id\`);`,
      )
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(
        `CREATE UNIQUE INDEX \`raya_routine_effect_attempt_identity\` ON \`raya_routine_effect_attempt\` (\`capsule\`,\`purpose\`);`,
      )
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(
        `CREATE INDEX \`raya_routine_effect_attempt_debt\` ON \`raya_routine_effect_attempt\` (\`capsule\`,\`state\`);`,
      )
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(
        `CREATE UNIQUE INDEX \`raya_routine_effect_capsule_step\` ON \`raya_routine_effect_capsule\` (\`run\`,\`session\`,\`step\`);`,
      )
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(
        `CREATE INDEX \`raya_routine_effect_capsule_run\` ON \`raya_routine_effect_capsule\` (\`run\`,\`state\`);`,
      )
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(
        `CREATE INDEX \`raya_routine_effect_membership_scope\` ON \`raya_routine_effect_membership\` (\`scope\`,\`generation\`,\`capsule\`);`,
      )
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(
        `CREATE INDEX \`raya_routine_effect_participant_profile\` ON \`raya_routine_effect_participant\` (\`profile\`,\`state\`);`,
      )
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(
        `CREATE UNIQUE INDEX \`raya_routine_effect_revocation_identity\` ON \`raya_routine_effect_revocation\` (\`scope\`,\`generation\`);`,
      )
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(
        `CREATE INDEX \`raya_routine_effect_revocation_pending\` ON \`raya_routine_effect_revocation\` (\`scope\`,\`state\`);`,
      )
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(
        `CREATE UNIQUE INDEX \`raya_routine_effect_scope_identity\` ON \`raya_routine_effect_scope\` (\`kind\`,\`principal\`,\`birth\`);`,
      )
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(
        `CREATE INDEX \`raya_routine_attachment_owner\` ON \`raya_routine_attachment\` (\`agent_id\`,\`message_id\`,\`time_created\`);`,
      )
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(
        `CREATE UNIQUE INDEX \`raya_routine_delegation_source\` ON \`raya_routine_delegation\` (\`source\`);`,
      )
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(
        `CREATE INDEX \`raya_routine_delegation_recipient\` ON \`raya_routine_delegation\` (\`recipient_id\`,\`state\`,\`time_created\`);`,
      )
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`CREATE INDEX \`raya_routine_delegation_parent\` ON \`raya_routine_delegation\` (\`parent_id\`);`)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`CREATE INDEX \`raya_routine_delegation_run\` ON \`raya_routine_delegation\` (\`parent_run_id\`);`)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(
        `CREATE INDEX \`raya_routine_delegation_organization\` ON \`raya_routine_delegation\` (\`organization_id\`,\`organization_revision\`);`,
      )
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(
        `CREATE UNIQUE INDEX \`raya_routine_message_source\` ON \`raya_routine_message\` (\`agent_id\`,\`source\`);`,
      )
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(
        `CREATE INDEX \`raya_routine_message_order\` ON \`raya_routine_message\` (\`agent_id\`,\`time_created\`,\`id\`);`,
      )
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(
        `CREATE UNIQUE INDEX \`raya_routine_occurrence_identity\` ON \`raya_routine_occurrence\` (\`agent_id\`,\`schedule_version\`,\`scheduled_at\`);`,
      )
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(
        `CREATE INDEX \`raya_routine_occurrence_pending\` ON \`raya_routine_occurrence\` (\`agent_id\`,\`schedule_version\`,\`state\`,\`scheduled_at\`);`,
      )
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(
        `CREATE INDEX \`raya_routine_occurrence_lease\` ON \`raya_routine_occurrence\` (\`state\`,\`lease_until\`);`,
      )
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(
        `CREATE INDEX \`raya_routine_occurrence_cleanup\` ON \`raya_routine_occurrence\` (\`agent_id\`,\`state\`,\`schedule_version\`,\`scheduled_at\`,\`id\`);`,
      )
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(
        `CREATE INDEX \`raya_routine_organization_coordinator_ledger\` ON \`raya_routine_organization_coordinator\` (\`organization_id\`,\`state\`);`,
      )
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(
        `CREATE UNIQUE INDEX \`raya_routine_organization_delegation_position\` ON \`raya_routine_organization_delegation\` (\`organization_id\`,\`position\`);`,
      )
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(
        `CREATE INDEX \`raya_routine_organization_delegation_recipient\` ON \`raya_routine_organization_delegation\` (\`organization_id\`,\`recipient_id\`);`,
      )
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(
        `CREATE UNIQUE INDEX \`raya_routine_organization_member_position\` ON \`raya_routine_organization_member\` (\`organization_id\`,\`position\`);`,
      )
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(
        `CREATE INDEX \`raya_routine_organization_member_agent\` ON \`raya_routine_organization_member\` (\`agent_id\`,\`organization_id\`);`,
      )
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(
        `CREATE INDEX \`raya_routine_organization_member_supervisor\` ON \`raya_routine_organization_member\` (\`organization_id\`,\`supervisor_id\`);`,
      )
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(
        `CREATE INDEX \`raya_routine_organization_reservation_ledger\` ON \`raya_routine_organization_reservation\` (\`organization_id\`,\`state\`);`,
      )
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(
        `CREATE UNIQUE INDEX \`raya_routine_organization_reservation_session\` ON \`raya_routine_organization_reservation\` (\`session_id\`);`,
      )
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(
        `CREATE INDEX \`raya_routine_organization_lifecycle\` ON \`raya_routine_organization\` (\`archived_at\`,\`time_updated\`,\`id\`);`,
      )
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`CREATE INDEX \`raya_voice_binding_session_idx\` ON \`raya_voice_binding\` (\`session_id\`);`)
      // kilocode_change end
      yield* tx.run(`CREATE UNIQUE INDEX \`event_aggregate_seq_idx\` ON \`event\` (\`aggregate_id\`,\`seq\`);`)
      yield* tx.run(`CREATE INDEX \`event_aggregate_type_seq_idx\` ON \`event\` (\`aggregate_id\`,\`type\`,\`seq\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`permission_project_action_resource_idx\` ON \`permission\` (\`project_id\`,\`action\`,\`resource\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`message_session_time_created_id_idx\` ON \`message\` (\`session_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`part_message_id_id_idx\` ON \`part\` (\`message_id\`,\`id\`);`)
      yield* tx.run(`CREATE INDEX \`part_session_idx\` ON \`part\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`recall_part_search_idx\` ON \`part\` (\`session_id\`,\`id\`,\`message_id\`,json_extract("data", '$.type'),CASE WHEN json_extract("data", '$.type') = 'text' THEN coalesce(json_extract("data", '$.text'), '') WHEN json_extract("data", '$.type') = 'file' THEN trim(coalesce(json_extract("data", '$.filename'), '') || ' ' || CASE WHEN coalesce(json_extract("data", '$.url'), '') NOT LIKE 'data:%' THEN coalesce(json_extract("data", '$.url'), '') ELSE '' END || ' ' || coalesce(json_extract("data", '$.source.path'), '') || ' ' || coalesce(json_extract("data", '$.source.name'), '') || ' ' || CASE WHEN coalesce(json_extract("data", '$.source.uri'), '') NOT LIKE 'data:%' THEN coalesce(json_extract("data", '$.source.uri'), '') ELSE '' END || ' ' || coalesce(json_extract("data", '$.source.clientName'), '')) ELSE coalesce(json_extract("data", '$.state.error'), '') END) WHERE json_valid("part"."data") AND ((json_extract("part"."data", '$.type') = 'text' AND coalesce(json_extract("part"."data", '$.synthetic'), 0) = 0 AND coalesce(json_extract("part"."data", '$.ignored'), 0) = 0) OR json_extract("part"."data", '$.type') = 'file' OR (json_extract("part"."data", '$.type') = 'tool' AND json_extract("part"."data", '$.state.status') = 'error'));`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_input_session_pending_delivery_seq_idx\` ON \`session_input\` (\`session_id\`,\`promoted_seq\`,\`delivery\`,\`admitted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_input_session_admitted_seq_idx\` ON \`session_input\` (\`session_id\`,\`admitted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_input_session_promoted_seq_idx\` ON \`session_input\` (\`session_id\`,\`promoted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_message_session_seq_idx\` ON \`session_message\` (\`session_id\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_message_session_type_seq_idx\` ON \`session_message\` (\`session_id\`,\`type\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_message_session_time_created_id_idx\` ON \`session_message\` (\`session_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_message_time_created_idx\` ON \`session_message\` (\`time_created\`);`)
      yield* tx.run(`CREATE INDEX \`session_project_idx\` ON \`session\` (\`project_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_workspace_idx\` ON \`session\` (\`workspace_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_parent_idx\` ON \`session\` (\`parent_id\`);`)
      yield* tx.run(`CREATE INDEX \`todo_session_idx\` ON \`todo\` (\`session_id\`);`)
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_session_insert
        AFTER INSERT ON session
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (NEW.id)))
            ) OR (session IN (NEW.id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (NEW.id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_session_update
        AFTER UPDATE ON session
        WHEN (OLD.id IS NOT NEW.id OR OLD.project_id IS NOT NEW.project_id OR OLD.workspace_id IS NOT NEW.workspace_id OR OLD.parent_id IS NOT NEW.parent_id OR OLD.directory IS NOT NEW.directory OR OLD.path IS NOT NEW.path OR OLD.metadata IS NOT NEW.metadata OR OLD.revert IS NOT NEW.revert OR OLD.permission IS NOT NEW.permission OR OLD.agent IS NOT NEW.agent OR OLD.model IS NOT NEW.model OR OLD.time_archived IS NOT NEW.time_archived) AND (1 OR 0 OR 0 OR 0 OR 0)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (OLD.id, NEW.id)))
            ) OR (session IN (OLD.id, NEW.id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (OLD.id, NEW.id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_session_delete
        BEFORE DELETE ON session
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (OLD.id)))
            ) OR (session IN (OLD.id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (OLD.id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_message_insert
        AFTER INSERT ON message
        WHEN (CASE WHEN (CASE WHEN length(CAST(NEW.data AS BLOB)) <= 2097152 THEN json_valid(NEW.data) ELSE 0 END) THEN json_extract(NEW.data, '$.role') IS NOT 'assistant' ELSE 1 END)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (NEW.session_id)))
            ) OR (session IN (NEW.session_id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (NEW.session_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_message_update
        AFTER UPDATE ON message
        WHEN (OLD.id IS NOT NEW.id OR OLD.session_id IS NOT NEW.session_id OR OLD.data IS NOT NEW.data OR OLD.time_created IS NOT NEW.time_created) AND ((CASE WHEN (CASE WHEN length(CAST(OLD.data AS BLOB)) <= 2097152 THEN json_valid(OLD.data) ELSE 0 END) THEN json_extract(OLD.data, '$.role') IS NOT 'assistant' ELSE 1 END OR CASE WHEN (CASE WHEN length(CAST(NEW.data AS BLOB)) <= 2097152 THEN json_valid(NEW.data) ELSE 0 END) THEN json_extract(NEW.data, '$.role') IS NOT 'assistant' ELSE 1 END) OR OLD.id IS NOT NEW.id OR OLD.session_id IS NOT NEW.session_id OR OLD.time_created IS NOT NEW.time_created OR CASE WHEN (CASE WHEN length(CAST(OLD.data AS BLOB)) <= 2097152 THEN json_valid(OLD.data) ELSE 0 END) AND (CASE WHEN length(CAST(NEW.data AS BLOB)) <= 2097152 THEN json_valid(NEW.data) ELSE 0 END) THEN (json_extract(OLD.data, '$.parentID') IS NOT json_extract(NEW.data, '$.parentID') OR json_extract(OLD.data, '$.agent') IS NOT json_extract(NEW.data, '$.agent') OR json_extract(OLD.data, '$.mode') IS NOT json_extract(NEW.data, '$.mode') OR json_extract(OLD.data, '$.modelID') IS NOT json_extract(NEW.data, '$.modelID') OR json_extract(OLD.data, '$.providerID') IS NOT json_extract(NEW.data, '$.providerID') OR json_extract(OLD.data, '$.model') IS NOT json_extract(NEW.data, '$.model') OR json_extract(OLD.data, '$.variant') IS NOT json_extract(NEW.data, '$.variant') OR json_extract(OLD.data, '$.path') IS NOT json_extract(NEW.data, '$.path') OR json_extract(OLD.data, '$.request') IS NOT json_extract(NEW.data, '$.request') OR json_extract(OLD.data, '$.metadata') IS NOT json_extract(NEW.data, '$.metadata') OR json_extract(OLD.data, '$.time.created') IS NOT json_extract(NEW.data, '$.time.created')) ELSE 1 END OR 0 OR 0)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (OLD.session_id, NEW.session_id)))
            ) OR (session IN (OLD.session_id, NEW.session_id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (OLD.session_id, NEW.session_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_message_delete
        BEFORE DELETE ON message
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (OLD.session_id)))
            ) OR (session IN (OLD.session_id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (OLD.session_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_part_insert
        AFTER INSERT ON part
        WHEN ((NOT (CASE WHEN length(CAST(NEW.data AS BLOB)) <= 2097152 THEN json_valid(NEW.data) ELSE 0 END) OR NOT EXISTS (SELECT 1 FROM message WHERE id = NEW.message_id AND session_id = NEW.session_id AND CASE WHEN (CASE WHEN length(CAST(message.data AS BLOB)) <= 2097152 THEN json_valid(message.data) ELSE 0 END) THEN json_extract(data, '$.role') = 'assistant' ELSE 0 END)))
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (NEW.session_id)))
            ) OR (session IN (NEW.session_id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (NEW.session_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_part_update
        AFTER UPDATE ON part
        WHEN (OLD.id IS NOT NEW.id OR OLD.message_id IS NOT NEW.message_id OR OLD.session_id IS NOT NEW.session_id OR OLD.data IS NOT NEW.data OR OLD.time_created IS NOT NEW.time_created) AND (((NOT (CASE WHEN length(CAST(OLD.data AS BLOB)) <= 2097152 THEN json_valid(OLD.data) ELSE 0 END) OR NOT EXISTS (SELECT 1 FROM message WHERE id = OLD.message_id AND session_id = OLD.session_id AND CASE WHEN (CASE WHEN length(CAST(message.data AS BLOB)) <= 2097152 THEN json_valid(message.data) ELSE 0 END) THEN json_extract(data, '$.role') = 'assistant' ELSE 0 END)) OR (NOT (CASE WHEN length(CAST(NEW.data AS BLOB)) <= 2097152 THEN json_valid(NEW.data) ELSE 0 END) OR NOT EXISTS (SELECT 1 FROM message WHERE id = NEW.message_id AND session_id = NEW.session_id AND CASE WHEN (CASE WHEN length(CAST(message.data AS BLOB)) <= 2097152 THEN json_valid(message.data) ELSE 0 END) THEN json_extract(data, '$.role') = 'assistant' ELSE 0 END))) OR OLD.id IS NOT NEW.id OR OLD.message_id IS NOT NEW.message_id OR OLD.session_id IS NOT NEW.session_id OR OLD.time_created IS NOT NEW.time_created OR CASE WHEN (CASE WHEN length(CAST(OLD.data AS BLOB)) <= 2097152 THEN json_valid(OLD.data) ELSE 0 END) AND (CASE WHEN length(CAST(NEW.data AS BLOB)) <= 2097152 THEN json_valid(NEW.data) ELSE 0 END) THEN (json_extract(OLD.data, '$.type') IS NOT json_extract(NEW.data, '$.type') OR json_extract(OLD.data, '$.tool') IS NOT json_extract(NEW.data, '$.tool') OR json_extract(OLD.data, '$.callID') IS NOT json_extract(NEW.data, '$.callID') OR json_extract(OLD.data, '$.state.input') IS NOT json_extract(NEW.data, '$.state.input') OR json_extract(OLD.data, '$.state.time.start') IS NOT json_extract(NEW.data, '$.state.time.start')) ELSE 1 END OR CASE WHEN (CASE WHEN length(CAST(OLD.data AS BLOB)) <= 2097152 THEN json_valid(OLD.data) ELSE 0 END) AND (CASE WHEN length(CAST(NEW.data AS BLOB)) <= 2097152 THEN json_valid(NEW.data) ELSE 0 END) THEN (json_extract(OLD.data, '$.state.status') IN ('completed', 'error') AND (json_extract(OLD.data, '$.state') IS NOT json_extract(NEW.data, '$.state'))) ELSE 1 END OR 0)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (OLD.session_id, NEW.session_id)))
            ) OR (session IN (OLD.session_id, NEW.session_id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (OLD.session_id, NEW.session_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_part_delete
        BEFORE DELETE ON part
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (OLD.session_id)))
            ) OR (session IN (OLD.session_id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (OLD.session_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_session_message_insert
        AFTER INSERT ON session_message
        WHEN ((NOT (CASE WHEN (CASE WHEN length(CAST(NEW.data AS BLOB)) <= 2097152 THEN json_valid(NEW.data) ELSE 0 END) THEN (json_type(NEW.data, '$.content') IS NULL OR (json_type(NEW.data, '$.content') = 'array' AND json_array_length(NEW.data, '$.content') <= 1024)) ELSE 0 END) OR NEW.type NOT IN ('assistant', 'tool', 'text', 'reasoning')))
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (NEW.session_id)))
            ) OR (session IN (NEW.session_id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (NEW.session_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_session_message_update
        AFTER UPDATE ON session_message
        WHEN (OLD.id IS NOT NEW.id OR OLD.session_id IS NOT NEW.session_id OR OLD.type IS NOT NEW.type OR OLD.seq IS NOT NEW.seq OR OLD.data IS NOT NEW.data OR OLD.time_created IS NOT NEW.time_created) AND (((NOT (CASE WHEN (CASE WHEN length(CAST(OLD.data AS BLOB)) <= 2097152 THEN json_valid(OLD.data) ELSE 0 END) THEN (json_type(OLD.data, '$.content') IS NULL OR (json_type(OLD.data, '$.content') = 'array' AND json_array_length(OLD.data, '$.content') <= 1024)) ELSE 0 END) OR OLD.type NOT IN ('assistant', 'tool', 'text', 'reasoning')) OR (NOT (CASE WHEN (CASE WHEN length(CAST(NEW.data AS BLOB)) <= 2097152 THEN json_valid(NEW.data) ELSE 0 END) THEN (json_type(NEW.data, '$.content') IS NULL OR (json_type(NEW.data, '$.content') = 'array' AND json_array_length(NEW.data, '$.content') <= 1024)) ELSE 0 END) OR NEW.type NOT IN ('assistant', 'tool', 'text', 'reasoning'))) OR OLD.id IS NOT NEW.id OR OLD.session_id IS NOT NEW.session_id OR OLD.type IS NOT NEW.type OR OLD.seq IS NOT NEW.seq OR OLD.time_created IS NOT NEW.time_created OR CASE WHEN (CASE WHEN length(CAST(OLD.data AS BLOB)) <= 2097152 THEN json_valid(OLD.data) ELSE 0 END) AND (CASE WHEN length(CAST(NEW.data AS BLOB)) <= 2097152 THEN json_valid(NEW.data) ELSE 0 END) THEN (json_extract(OLD.data, '$.agent') IS NOT json_extract(NEW.data, '$.agent') OR json_extract(OLD.data, '$.model') IS NOT json_extract(NEW.data, '$.model') OR json_extract(OLD.data, '$.parentID') IS NOT json_extract(NEW.data, '$.parentID') OR json_extract(OLD.data, '$.request') IS NOT json_extract(NEW.data, '$.request') OR json_extract(OLD.data, '$.metadata') IS NOT json_extract(NEW.data, '$.metadata') OR json_extract(OLD.data, '$.id') IS NOT json_extract(NEW.data, '$.id') OR json_extract(OLD.data, '$.name') IS NOT json_extract(NEW.data, '$.name') OR json_extract(OLD.data, '$.state.input') IS NOT json_extract(NEW.data, '$.state.input') OR json_extract(OLD.data, '$.time.created') IS NOT json_extract(NEW.data, '$.time.created')) ELSE 1 END OR CASE WHEN (CASE WHEN length(CAST(OLD.data AS BLOB)) <= 2097152 THEN json_valid(OLD.data) ELSE 0 END) AND (CASE WHEN length(CAST(NEW.data AS BLOB)) <= 2097152 THEN json_valid(NEW.data) ELSE 0 END) THEN (json_extract(OLD.data, '$.state.status') IN ('completed', 'error') AND (json_extract(OLD.data, '$.state') IS NOT json_extract(NEW.data, '$.state'))) ELSE 1 END OR CASE WHEN (CASE WHEN (CASE WHEN length(CAST(OLD.data AS BLOB)) <= 2097152 THEN json_valid(OLD.data) ELSE 0 END) THEN (json_type(OLD.data, '$.content') IS NULL OR (json_type(OLD.data, '$.content') = 'array' AND json_array_length(OLD.data, '$.content') <= 1024)) ELSE 0 END) AND (CASE WHEN (CASE WHEN length(CAST(NEW.data AS BLOB)) <= 2097152 THEN json_valid(NEW.data) ELSE 0 END) THEN (json_type(NEW.data, '$.content') IS NULL OR (json_type(NEW.data, '$.content') = 'array' AND json_array_length(NEW.data, '$.content') <= 1024)) ELSE 0 END) THEN (CASE
          WHEN json_type(OLD.data, '$.content') IS NULL THEN '[]'
          WHEN json_type(OLD.data, '$.content') IS NOT 'array' THEN OLD.data
          ELSE (SELECT json_group_array(CASE WHEN json_valid(value) THEN json_object(
            'id', json_extract(value, '$.id'), 'name', json_extract(value, '$.name'),
            'input', json_extract(value, '$.state.input'), 'created', json_extract(value, '$.time.created'),
            'terminal', CASE WHEN json_extract(items.value, '$.id') IN (
              SELECT CASE WHEN json_valid(previous.value) THEN json_extract(previous.value, '$.id') ELSE NULL END
              FROM json_each(OLD.data, '$.content') AS previous
              WHERE CASE WHEN json_valid(previous.value) THEN
                json_extract(previous.value, '$.type') = 'tool'
                AND json_extract(previous.value, '$.state.status') IN ('completed', 'error')
              ELSE 0 END
            ) THEN json_object('state', json_extract(value, '$.state'), 'time', json_extract(value, '$.time'), 'provider', json_extract(value, '$.provider')) ELSE NULL END
          ) ELSE json_object('invalid', value) END)
          FROM json_each(OLD.data, '$.content') AS items
          WHERE CASE WHEN json_valid(value) THEN json_extract(value, '$.type') = 'tool' ELSE 1 END)
        END IS NOT CASE
          WHEN json_type(NEW.data, '$.content') IS NULL THEN '[]'
          WHEN json_type(NEW.data, '$.content') IS NOT 'array' THEN NEW.data
          ELSE (SELECT json_group_array(CASE WHEN json_valid(value) THEN json_object(
            'id', json_extract(value, '$.id'), 'name', json_extract(value, '$.name'),
            'input', json_extract(value, '$.state.input'), 'created', json_extract(value, '$.time.created'),
            'terminal', CASE WHEN json_extract(items.value, '$.id') IN (
              SELECT CASE WHEN json_valid(previous.value) THEN json_extract(previous.value, '$.id') ELSE NULL END
              FROM json_each(OLD.data, '$.content') AS previous
              WHERE CASE WHEN json_valid(previous.value) THEN
                json_extract(previous.value, '$.type') = 'tool'
                AND json_extract(previous.value, '$.state.status') IN ('completed', 'error')
              ELSE 0 END
            ) THEN json_object('state', json_extract(value, '$.state'), 'time', json_extract(value, '$.time'), 'provider', json_extract(value, '$.provider')) ELSE NULL END
          ) ELSE json_object('invalid', value) END)
          FROM json_each(NEW.data, '$.content') AS items
          WHERE CASE WHEN json_valid(value) THEN json_extract(value, '$.type') = 'tool' ELSE 1 END)
        END) ELSE 1 END)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (OLD.session_id, NEW.session_id)))
            ) OR (session IN (OLD.session_id, NEW.session_id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (OLD.session_id, NEW.session_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_session_message_delete
        BEFORE DELETE ON session_message
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (OLD.session_id)))
            ) OR (session IN (OLD.session_id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (OLD.session_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_session_input_insert
        AFTER INSERT ON session_input
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (NEW.session_id)))
            ) OR (session IN (NEW.session_id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (NEW.session_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_session_input_update
        AFTER UPDATE ON session_input
        WHEN (OLD.id IS NOT NEW.id OR OLD.session_id IS NOT NEW.session_id OR OLD.prompt IS NOT NEW.prompt OR OLD.delivery IS NOT NEW.delivery OR OLD.admitted_seq IS NOT NEW.admitted_seq OR OLD.promoted_seq IS NOT NEW.promoted_seq) AND (1 OR 0 OR 0 OR 0 OR 0)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (OLD.session_id, NEW.session_id)))
            ) OR (session IN (OLD.session_id, NEW.session_id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (OLD.session_id, NEW.session_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_session_input_delete
        BEFORE DELETE ON session_input
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (OLD.session_id)))
            ) OR (session IN (OLD.session_id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (OLD.session_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_session_context_epoch_insert
        AFTER INSERT ON session_context_epoch
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (NEW.session_id)))
            ) OR (session IN (NEW.session_id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (NEW.session_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_session_context_epoch_update
        AFTER UPDATE ON session_context_epoch
        WHEN (OLD.session_id IS NOT NEW.session_id OR OLD.baseline IS NOT NEW.baseline OR OLD.snapshot IS NOT NEW.snapshot OR OLD.baseline_seq IS NOT NEW.baseline_seq) AND (1 OR 0 OR 0 OR 0 OR 0)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (OLD.session_id, NEW.session_id)))
            ) OR (session IN (OLD.session_id, NEW.session_id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (OLD.session_id, NEW.session_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_session_context_epoch_delete
        BEFORE DELETE ON session_context_epoch
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (OLD.session_id)))
            ) OR (session IN (OLD.session_id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (OLD.session_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_permission_insert
        AFTER INSERT ON permission
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (SELECT id FROM session WHERE project_id IN (NEW.project_id))) OR (kind = 'workspace' AND principal IN (SELECT id FROM workspace WHERE project_id IN (NEW.project_id))))
            ) OR (session IN (SELECT id FROM session WHERE project_id IN (NEW.project_id)))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (SELECT id FROM session WHERE project_id IN (NEW.project_id))) OR (kind = 'workspace' AND principal IN (SELECT id FROM workspace WHERE project_id IN (NEW.project_id))));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_permission_update
        AFTER UPDATE ON permission
        WHEN (OLD.id IS NOT NEW.id OR OLD.project_id IS NOT NEW.project_id OR OLD.action IS NOT NEW.action OR OLD.resource IS NOT NEW.resource) AND (1 OR 0 OR 0 OR 0 OR 0)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (SELECT id FROM session WHERE project_id IN (OLD.project_id, NEW.project_id))) OR (kind = 'workspace' AND principal IN (SELECT id FROM workspace WHERE project_id IN (OLD.project_id, NEW.project_id))))
            ) OR (session IN (SELECT id FROM session WHERE project_id IN (OLD.project_id, NEW.project_id)))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (SELECT id FROM session WHERE project_id IN (OLD.project_id, NEW.project_id))) OR (kind = 'workspace' AND principal IN (SELECT id FROM workspace WHERE project_id IN (OLD.project_id, NEW.project_id))));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_permission_delete
        BEFORE DELETE ON permission
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (SELECT id FROM session WHERE project_id IN (OLD.project_id))) OR (kind = 'workspace' AND principal IN (SELECT id FROM workspace WHERE project_id IN (OLD.project_id))))
            ) OR (session IN (SELECT id FROM session WHERE project_id IN (OLD.project_id)))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (SELECT id FROM session WHERE project_id IN (OLD.project_id))) OR (kind = 'workspace' AND principal IN (SELECT id FROM workspace WHERE project_id IN (OLD.project_id))));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_project_insert
        AFTER INSERT ON project
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (SELECT id FROM session WHERE project_id IN (NEW.id))) OR (kind = 'workspace' AND principal IN (SELECT id FROM workspace WHERE project_id IN (NEW.id))))
            ) OR (session IN (SELECT id FROM session WHERE project_id IN (NEW.id)))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (SELECT id FROM session WHERE project_id IN (NEW.id))) OR (kind = 'workspace' AND principal IN (SELECT id FROM workspace WHERE project_id IN (NEW.id))));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_project_update
        AFTER UPDATE ON project
        WHEN (OLD.id IS NOT NEW.id OR OLD.worktree IS NOT NEW.worktree OR OLD.vcs IS NOT NEW.vcs OR OLD.sandboxes IS NOT NEW.sandboxes OR OLD.commands IS NOT NEW.commands) AND (1 OR 0 OR 0 OR 0 OR 0)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (SELECT id FROM session WHERE project_id IN (OLD.id, NEW.id))) OR (kind = 'workspace' AND principal IN (SELECT id FROM workspace WHERE project_id IN (OLD.id, NEW.id))))
            ) OR (session IN (SELECT id FROM session WHERE project_id IN (OLD.id, NEW.id)))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (SELECT id FROM session WHERE project_id IN (OLD.id, NEW.id))) OR (kind = 'workspace' AND principal IN (SELECT id FROM workspace WHERE project_id IN (OLD.id, NEW.id))));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_project_delete
        BEFORE DELETE ON project
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (SELECT id FROM session WHERE project_id IN (OLD.id))) OR (kind = 'workspace' AND principal IN (SELECT id FROM workspace WHERE project_id IN (OLD.id))))
            ) OR (session IN (SELECT id FROM session WHERE project_id IN (OLD.id)))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (SELECT id FROM session WHERE project_id IN (OLD.id))) OR (kind = 'workspace' AND principal IN (SELECT id FROM workspace WHERE project_id IN (OLD.id))));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_project_directory_insert
        AFTER INSERT ON project_directory
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (SELECT id FROM session WHERE project_id IN (NEW.project_id))) OR (kind = 'workspace' AND principal IN (SELECT id FROM workspace WHERE project_id IN (NEW.project_id))))
            ) OR (session IN (SELECT id FROM session WHERE project_id IN (NEW.project_id)))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (SELECT id FROM session WHERE project_id IN (NEW.project_id))) OR (kind = 'workspace' AND principal IN (SELECT id FROM workspace WHERE project_id IN (NEW.project_id))));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_project_directory_update
        AFTER UPDATE ON project_directory
        WHEN (OLD.project_id IS NOT NEW.project_id OR OLD.directory IS NOT NEW.directory OR OLD.type IS NOT NEW.type OR OLD.strategy IS NOT NEW.strategy) AND (1 OR 0 OR 0 OR 0 OR 0)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (SELECT id FROM session WHERE project_id IN (OLD.project_id, NEW.project_id))) OR (kind = 'workspace' AND principal IN (SELECT id FROM workspace WHERE project_id IN (OLD.project_id, NEW.project_id))))
            ) OR (session IN (SELECT id FROM session WHERE project_id IN (OLD.project_id, NEW.project_id)))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (SELECT id FROM session WHERE project_id IN (OLD.project_id, NEW.project_id))) OR (kind = 'workspace' AND principal IN (SELECT id FROM workspace WHERE project_id IN (OLD.project_id, NEW.project_id))));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_project_directory_delete
        BEFORE DELETE ON project_directory
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (SELECT id FROM session WHERE project_id IN (OLD.project_id))) OR (kind = 'workspace' AND principal IN (SELECT id FROM workspace WHERE project_id IN (OLD.project_id))))
            ) OR (session IN (SELECT id FROM session WHERE project_id IN (OLD.project_id)))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (SELECT id FROM session WHERE project_id IN (OLD.project_id))) OR (kind = 'workspace' AND principal IN (SELECT id FROM workspace WHERE project_id IN (OLD.project_id))));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_workspace_insert
        AFTER INSERT ON workspace
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'workspace' AND principal IN (NEW.id)) OR (kind = 'session' AND principal IN (SELECT id FROM session WHERE workspace_id IN (NEW.id))))
            ) OR (session IN (SELECT id FROM session WHERE workspace_id IN (NEW.id)))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'workspace' AND principal IN (NEW.id)) OR (kind = 'session' AND principal IN (SELECT id FROM session WHERE workspace_id IN (NEW.id))));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_workspace_update
        AFTER UPDATE ON workspace
        WHEN (OLD.id IS NOT NEW.id OR OLD.type IS NOT NEW.type OR OLD.branch IS NOT NEW.branch OR OLD.directory IS NOT NEW.directory OR OLD.extra IS NOT NEW.extra OR OLD.project_id IS NOT NEW.project_id) AND (1 OR 0 OR 0 OR 0 OR 0)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'workspace' AND principal IN (OLD.id, NEW.id)) OR (kind = 'session' AND principal IN (SELECT id FROM session WHERE workspace_id IN (OLD.id, NEW.id))))
            ) OR (session IN (SELECT id FROM session WHERE workspace_id IN (OLD.id, NEW.id)))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'workspace' AND principal IN (OLD.id, NEW.id)) OR (kind = 'session' AND principal IN (SELECT id FROM session WHERE workspace_id IN (OLD.id, NEW.id))));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_workspace_delete
        BEFORE DELETE ON workspace
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'workspace' AND principal IN (OLD.id)) OR (kind = 'session' AND principal IN (SELECT id FROM session WHERE workspace_id IN (OLD.id))))
            ) OR (session IN (SELECT id FROM session WHERE workspace_id IN (OLD.id)))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'workspace' AND principal IN (OLD.id)) OR (kind = 'session' AND principal IN (SELECT id FROM session WHERE workspace_id IN (OLD.id))));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_conversation_insert
        AFTER INSERT ON raya_routine_conversation
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'principal' AND principal IN (NEW.agent_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'principal' AND principal IN (NEW.agent_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_conversation_update
        AFTER UPDATE ON raya_routine_conversation
        WHEN (OLD.agent_id IS NOT NEW.agent_id OR OLD.id IS NOT NEW.id) AND (1 OR 0 OR 0 OR 0 OR 0)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'principal' AND principal IN (OLD.agent_id, NEW.agent_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'principal' AND principal IN (OLD.agent_id, NEW.agent_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_conversation_delete
        BEFORE DELETE ON raya_routine_conversation
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'principal' AND principal IN (OLD.agent_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'principal' AND principal IN (OLD.agent_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_message_insert
        AFTER INSERT ON raya_routine_message
        WHEN (NEW.kind NOT IN ('worker', 'report'))
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'principal' AND principal IN (NEW.agent_id)) OR (kind = 'session' AND principal IN (NEW.session_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'principal' AND principal IN (NEW.agent_id)) OR (kind = 'session' AND principal IN (NEW.session_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_message_update
        AFTER UPDATE ON raya_routine_message
        WHEN (OLD.id IS NOT NEW.id OR OLD.agent_id IS NOT NEW.agent_id OR OLD.source IS NOT NEW.source OR OLD.kind IS NOT NEW.kind OR OLD.body IS NOT NEW.body OR OLD.occurrence_id IS NOT NEW.occurrence_id OR OLD.session_id IS NOT NEW.session_id OR OLD.files IS NOT NEW.files OR OLD.attachments IS NOT NEW.attachments OR OLD.delivery_id IS NOT NEW.delivery_id) AND ((OLD.kind NOT IN ('worker', 'report') OR NEW.kind NOT IN ('worker', 'report')) OR OLD.id IS NOT NEW.id OR OLD.agent_id IS NOT NEW.agent_id OR OLD.source IS NOT NEW.source OR OLD.kind IS NOT NEW.kind OR OLD.session_id IS NOT NEW.session_id OR 0 OR 0 OR 0)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'principal' AND principal IN (OLD.agent_id, NEW.agent_id)) OR (kind = 'session' AND principal IN (OLD.session_id, NEW.session_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'principal' AND principal IN (OLD.agent_id, NEW.agent_id)) OR (kind = 'session' AND principal IN (OLD.session_id, NEW.session_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_message_delete
        BEFORE DELETE ON raya_routine_message
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'principal' AND principal IN (OLD.agent_id)) OR (kind = 'session' AND principal IN (OLD.session_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'principal' AND principal IN (OLD.agent_id)) OR (kind = 'session' AND principal IN (OLD.session_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_attachment_insert
        AFTER INSERT ON raya_routine_attachment
        WHEN (NEW.message_id IS NOT NULL)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'principal' AND principal IN (NEW.agent_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'principal' AND principal IN (NEW.agent_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_attachment_update
        AFTER UPDATE ON raya_routine_attachment
        WHEN (OLD.id IS NOT NEW.id OR OLD.agent_id IS NOT NEW.agent_id OR OLD.message_id IS NOT NEW.message_id OR OLD.name IS NOT NEW.name OR OLD.mime IS NOT NEW.mime OR OLD.size IS NOT NEW.size OR OLD.data IS NOT NEW.data OR OLD.sha256 IS NOT NEW.sha256) AND ((OLD.message_id IS NOT NULL OR NEW.message_id IS NOT NULL) OR OLD.id IS NOT NEW.id OR OLD.agent_id IS NOT NEW.agent_id OR OLD.message_id IS NOT NEW.message_id OR 0 OR 0 OR 0)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'principal' AND principal IN (OLD.agent_id, NEW.agent_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'principal' AND principal IN (OLD.agent_id, NEW.agent_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_attachment_delete
        BEFORE DELETE ON raya_routine_attachment
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'principal' AND principal IN (OLD.agent_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'principal' AND principal IN (OLD.agent_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_occurrence_insert
        AFTER INSERT ON raya_routine_occurrence
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'principal' AND principal IN (NEW.agent_id)) OR (kind = 'session' AND principal IN (NEW.session_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'principal' AND principal IN (NEW.agent_id)) OR (kind = 'session' AND principal IN (NEW.session_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_occurrence_update
        AFTER UPDATE ON raya_routine_occurrence
        WHEN (OLD.id IS NOT NEW.id OR OLD.agent_id IS NOT NEW.agent_id OR OLD.schedule_version IS NOT NEW.schedule_version OR OLD.scheduled_at IS NOT NEW.scheduled_at OR OLD.timezone IS NOT NEW.timezone OR OLD.state IS NOT NEW.state OR OLD.claim_id IS NOT NEW.claim_id OR OLD.owner IS NOT NEW.owner OR OLD.session_id IS NOT NEW.session_id) AND (1 OR 0 OR 0 OR 0 OR 0)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'principal' AND principal IN (OLD.agent_id, NEW.agent_id)) OR (kind = 'session' AND principal IN (OLD.session_id, NEW.session_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'principal' AND principal IN (OLD.agent_id, NEW.agent_id)) OR (kind = 'session' AND principal IN (OLD.session_id, NEW.session_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_occurrence_delete
        BEFORE DELETE ON raya_routine_occurrence
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'principal' AND principal IN (OLD.agent_id)) OR (kind = 'session' AND principal IN (OLD.session_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'principal' AND principal IN (OLD.agent_id)) OR (kind = 'session' AND principal IN (OLD.session_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_delegation_insert
        AFTER INSERT ON raya_routine_delegation
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'delegation' AND principal IN (NEW.id)) OR (kind = 'principal' AND principal IN (NEW.sender_id, NEW.recipient_id)) OR (kind = 'organization' AND principal IN (NEW.organization_id)) OR (kind = 'run' AND principal IN (NEW.parent_run_id, NEW.child_run_id)) OR (kind = 'session' AND principal IN (NEW.session_id)))
            ) OR (run IN (NEW.parent_run_id, NEW.child_run_id) OR session IN (NEW.session_id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'delegation' AND principal IN (NEW.id)) OR (kind = 'principal' AND principal IN (NEW.sender_id, NEW.recipient_id)) OR (kind = 'organization' AND principal IN (NEW.organization_id)) OR (kind = 'run' AND principal IN (NEW.parent_run_id, NEW.child_run_id)) OR (kind = 'session' AND principal IN (NEW.session_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_delegation_update
        AFTER UPDATE ON raya_routine_delegation
        WHEN (OLD.id IS NOT NEW.id OR OLD.source IS NOT NEW.source OR OLD.sender_id IS NOT NEW.sender_id OR OLD.recipient_id IS NOT NEW.recipient_id OR OLD.parent_id IS NOT NEW.parent_id OR OLD.parent_run_id IS NOT NEW.parent_run_id OR OLD.organization_id IS NOT NEW.organization_id OR OLD.organization_revision IS NOT NEW.organization_revision OR OLD.workspace IS NOT NEW.workspace OR OLD.objective IS NOT NEW.objective OR OLD.expected IS NOT NEW.expected OR OLD.context IS NOT NEW.context OR OLD.deadline IS NOT NEW.deadline OR OLD.budget IS NOT NEW.budget OR OLD.depth IS NOT NEW.depth OR OLD.state IS NOT NEW.state OR OLD.child_run_id IS NOT NEW.child_run_id OR OLD.session_id IS NOT NEW.session_id) AND (1 OR 0 OR 0 OR 0 OR 0)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'delegation' AND principal IN (OLD.id, NEW.id)) OR (kind = 'principal' AND principal IN (OLD.sender_id, NEW.sender_id, OLD.recipient_id, NEW.recipient_id)) OR (kind = 'organization' AND principal IN (OLD.organization_id, NEW.organization_id)) OR (kind = 'run' AND principal IN (OLD.parent_run_id, NEW.parent_run_id, OLD.child_run_id, NEW.child_run_id)) OR (kind = 'session' AND principal IN (OLD.session_id, NEW.session_id)))
            ) OR (run IN (OLD.parent_run_id, NEW.parent_run_id, OLD.child_run_id, NEW.child_run_id) OR session IN (OLD.session_id, NEW.session_id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'delegation' AND principal IN (OLD.id, NEW.id)) OR (kind = 'principal' AND principal IN (OLD.sender_id, NEW.sender_id, OLD.recipient_id, NEW.recipient_id)) OR (kind = 'organization' AND principal IN (OLD.organization_id, NEW.organization_id)) OR (kind = 'run' AND principal IN (OLD.parent_run_id, NEW.parent_run_id, OLD.child_run_id, NEW.child_run_id)) OR (kind = 'session' AND principal IN (OLD.session_id, NEW.session_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_delegation_delete
        BEFORE DELETE ON raya_routine_delegation
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'delegation' AND principal IN (OLD.id)) OR (kind = 'principal' AND principal IN (OLD.sender_id, OLD.recipient_id)) OR (kind = 'organization' AND principal IN (OLD.organization_id)) OR (kind = 'run' AND principal IN (OLD.parent_run_id, OLD.child_run_id)) OR (kind = 'session' AND principal IN (OLD.session_id)))
            ) OR (run IN (OLD.parent_run_id, OLD.child_run_id) OR session IN (OLD.session_id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'delegation' AND principal IN (OLD.id)) OR (kind = 'principal' AND principal IN (OLD.sender_id, OLD.recipient_id)) OR (kind = 'organization' AND principal IN (OLD.organization_id)) OR (kind = 'run' AND principal IN (OLD.parent_run_id, OLD.child_run_id)) OR (kind = 'session' AND principal IN (OLD.session_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_organization_insert
        AFTER INSERT ON raya_routine_organization
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'organization' AND principal IN (NEW.id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'organization' AND principal IN (NEW.id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_organization_update
        AFTER UPDATE ON raya_routine_organization
        WHEN (OLD.id IS NOT NEW.id OR OLD.name IS NOT NEW.name OR OLD.purpose IS NOT NEW.purpose OR OLD.policy IS NOT NEW.policy OR OLD.budget IS NOT NEW.budget OR OLD.revision IS NOT NEW.revision OR OLD.archived_at IS NOT NEW.archived_at OR OLD.stopping_at IS NOT NEW.stopping_at OR OLD.stopped_at IS NOT NEW.stopped_at) AND (1 OR 0 OR 0 OR 0 OR 0)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'organization' AND principal IN (OLD.id, NEW.id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'organization' AND principal IN (OLD.id, NEW.id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_organization_delete
        BEFORE DELETE ON raya_routine_organization
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'organization' AND principal IN (OLD.id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'organization' AND principal IN (OLD.id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_organization_member_insert
        AFTER INSERT ON raya_routine_organization_member
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'organization' AND principal IN (NEW.organization_id)) OR (kind = 'principal' AND principal IN (NEW.agent_id, NEW.supervisor_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'organization' AND principal IN (NEW.organization_id)) OR (kind = 'principal' AND principal IN (NEW.agent_id, NEW.supervisor_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_organization_member_update
        AFTER UPDATE ON raya_routine_organization_member
        WHEN (OLD.organization_id IS NOT NEW.organization_id OR OLD.agent_id IS NOT NEW.agent_id OR OLD.role IS NOT NEW.role OR OLD.position IS NOT NEW.position OR OLD.supervisor_id IS NOT NEW.supervisor_id) AND (1 OR 0 OR 0 OR 0 OR 0)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'organization' AND principal IN (OLD.organization_id, NEW.organization_id)) OR (kind = 'principal' AND principal IN (OLD.agent_id, NEW.agent_id, OLD.supervisor_id, NEW.supervisor_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'organization' AND principal IN (OLD.organization_id, NEW.organization_id)) OR (kind = 'principal' AND principal IN (OLD.agent_id, NEW.agent_id, OLD.supervisor_id, NEW.supervisor_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_organization_member_delete
        BEFORE DELETE ON raya_routine_organization_member
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'organization' AND principal IN (OLD.organization_id)) OR (kind = 'principal' AND principal IN (OLD.agent_id, OLD.supervisor_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'organization' AND principal IN (OLD.organization_id)) OR (kind = 'principal' AND principal IN (OLD.agent_id, OLD.supervisor_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_organization_delegation_insert
        AFTER INSERT ON raya_routine_organization_delegation
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'organization' AND principal IN (NEW.organization_id)) OR (kind = 'principal' AND principal IN (NEW.sender_id, NEW.recipient_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'organization' AND principal IN (NEW.organization_id)) OR (kind = 'principal' AND principal IN (NEW.sender_id, NEW.recipient_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_organization_delegation_update
        AFTER UPDATE ON raya_routine_organization_delegation
        WHEN (OLD.organization_id IS NOT NEW.organization_id OR OLD.sender_id IS NOT NEW.sender_id OR OLD.recipient_id IS NOT NEW.recipient_id OR OLD.position IS NOT NEW.position) AND (1 OR 0 OR 0 OR 0 OR 0)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'organization' AND principal IN (OLD.organization_id, NEW.organization_id)) OR (kind = 'principal' AND principal IN (OLD.sender_id, NEW.sender_id, OLD.recipient_id, NEW.recipient_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'organization' AND principal IN (OLD.organization_id, NEW.organization_id)) OR (kind = 'principal' AND principal IN (OLD.sender_id, NEW.sender_id, OLD.recipient_id, NEW.recipient_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_organization_delegation_delete
        BEFORE DELETE ON raya_routine_organization_delegation
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'organization' AND principal IN (OLD.organization_id)) OR (kind = 'principal' AND principal IN (OLD.sender_id, OLD.recipient_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'organization' AND principal IN (OLD.organization_id)) OR (kind = 'principal' AND principal IN (OLD.sender_id, OLD.recipient_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_organization_revision_insert
        AFTER INSERT ON raya_routine_organization_revision
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'organization' AND principal IN (NEW.organization_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'organization' AND principal IN (NEW.organization_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_organization_revision_update
        AFTER UPDATE ON raya_routine_organization_revision
        WHEN (OLD.organization_id IS NOT NEW.organization_id OR OLD.revision IS NOT NEW.revision OR OLD.definition IS NOT NEW.definition) AND (1 OR 0 OR 0 OR 0 OR 0)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'organization' AND principal IN (OLD.organization_id, NEW.organization_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'organization' AND principal IN (OLD.organization_id, NEW.organization_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_organization_revision_delete
        BEFORE DELETE ON raya_routine_organization_revision
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'organization' AND principal IN (OLD.organization_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'organization' AND principal IN (OLD.organization_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_organization_reservation_insert
        AFTER INSERT ON raya_routine_organization_reservation
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'organization' AND principal IN (NEW.organization_id)) OR (kind = 'principal' AND principal IN (NEW.agent_id)) OR (kind = 'run' AND principal IN (NEW.run_id)) OR (kind = 'session' AND principal IN (NEW.session_id)))
            ) OR (run IN (NEW.run_id) OR session IN (NEW.session_id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'organization' AND principal IN (NEW.organization_id)) OR (kind = 'principal' AND principal IN (NEW.agent_id)) OR (kind = 'run' AND principal IN (NEW.run_id)) OR (kind = 'session' AND principal IN (NEW.session_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_organization_reservation_update
        AFTER UPDATE ON raya_routine_organization_reservation
        WHEN (OLD.run_id IS NOT NEW.run_id OR OLD.agent_id IS NOT NEW.agent_id OR OLD.organization_id IS NOT NEW.organization_id OR OLD.organization_revision IS NOT NEW.organization_revision OR OLD.session_id IS NOT NEW.session_id OR OLD.budget IS NOT NEW.budget OR OLD.cost IS NOT NEW.cost OR OLD.state IS NOT NEW.state) AND (1 OR 0 OR 0 OR 0 OR 0)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'organization' AND principal IN (OLD.organization_id, NEW.organization_id)) OR (kind = 'principal' AND principal IN (OLD.agent_id, NEW.agent_id)) OR (kind = 'run' AND principal IN (OLD.run_id, NEW.run_id)) OR (kind = 'session' AND principal IN (OLD.session_id, NEW.session_id)))
            ) OR (run IN (OLD.run_id, NEW.run_id) OR session IN (OLD.session_id, NEW.session_id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'organization' AND principal IN (OLD.organization_id, NEW.organization_id)) OR (kind = 'principal' AND principal IN (OLD.agent_id, NEW.agent_id)) OR (kind = 'run' AND principal IN (OLD.run_id, NEW.run_id)) OR (kind = 'session' AND principal IN (OLD.session_id, NEW.session_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_organization_reservation_delete
        BEFORE DELETE ON raya_routine_organization_reservation
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'organization' AND principal IN (OLD.organization_id)) OR (kind = 'principal' AND principal IN (OLD.agent_id)) OR (kind = 'run' AND principal IN (OLD.run_id)) OR (kind = 'session' AND principal IN (OLD.session_id)))
            ) OR (run IN (OLD.run_id) OR session IN (OLD.session_id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'organization' AND principal IN (OLD.organization_id)) OR (kind = 'principal' AND principal IN (OLD.agent_id)) OR (kind = 'run' AND principal IN (OLD.run_id)) OR (kind = 'session' AND principal IN (OLD.session_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_organization_coordinator_insert
        AFTER INSERT ON raya_routine_organization_coordinator
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'organization' AND principal IN (NEW.organization_id)) OR (kind = 'session' AND principal IN (NEW.session_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'organization' AND principal IN (NEW.organization_id)) OR (kind = 'session' AND principal IN (NEW.session_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_organization_coordinator_update
        AFTER UPDATE ON raya_routine_organization_coordinator
        WHEN (OLD.message_id IS NOT NEW.message_id OR OLD.session_id IS NOT NEW.session_id OR OLD.organization_id IS NOT NEW.organization_id OR OLD.organization_revision IS NOT NEW.organization_revision OR OLD.state IS NOT NEW.state) AND (1 OR 0 OR 0 OR 0 OR 0)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'organization' AND principal IN (OLD.organization_id, NEW.organization_id)) OR (kind = 'session' AND principal IN (OLD.session_id, NEW.session_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'organization' AND principal IN (OLD.organization_id, NEW.organization_id)) OR (kind = 'session' AND principal IN (OLD.session_id, NEW.session_id)));
        END;
      `)
      // kilocode_change end
      // kilocode_change start
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_organization_coordinator_delete
        BEFORE DELETE ON raya_routine_organization_coordinator
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'organization' AND principal IN (OLD.organization_id)) OR (kind = 'session' AND principal IN (OLD.session_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'organization' AND principal IN (OLD.organization_id)) OR (kind = 'session' AND principal IN (OLD.session_id)));
        END;
      `)
      // kilocode_change end
    })
  },
} satisfies Omit<DatabaseMigration.Migration, "id">
