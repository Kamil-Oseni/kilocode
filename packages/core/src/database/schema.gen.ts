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
    })
  },
} satisfies Omit<DatabaseMigration.Migration, "id">
