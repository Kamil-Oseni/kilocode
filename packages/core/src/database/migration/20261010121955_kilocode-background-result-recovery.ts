// kilocode_change - new file
import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261010121955_kilocode-background-result-recovery",
  up(tx) {
    return Effect.gen(function* () {
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
      yield* tx.run(
        `CREATE INDEX \`raya_result_notice_root_idx\` ON \`raya_result_notice\` (\`session_id\`,\`user_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`raya_result_notice_original_idx\` ON \`raya_result_notice\` (\`job_id\`,\`revision\`,\`call_id\`,\`input_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
