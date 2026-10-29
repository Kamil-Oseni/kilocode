import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261029115746_kilocode-routine-job-contract",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`raya_routine_job_contract\` (
          \`id\` text PRIMARY KEY,
          \`version\` integer NOT NULL,
          \`root_id\` text NOT NULL,
          \`root_source\` text NOT NULL,
          \`organization_id\` text NOT NULL,
          \`organization_revision\` integer NOT NULL,
          \`origin\` text NOT NULL,
          \`context\` text,
          \`proposal\` text NOT NULL,
          \`sha256\` text NOT NULL,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(`ALTER TABLE \`raya_routine_delegation\` ADD \`contract_id\` text;`)
      yield* tx.run(`ALTER TABLE \`raya_routine_delegation\` ADD \`contract_sha256\` text;`)
      yield* tx.run(`ALTER TABLE \`raya_routine_delegation\` ADD \`stage_id\` text;`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`raya_routine_delegation_contract_stage\` ON \`raya_routine_delegation\` (\`contract_id\`,\`stage_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`raya_routine_job_contract_root\` ON \`raya_routine_job_contract\` (\`root_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`raya_routine_job_contract_source\` ON \`raya_routine_job_contract\` (\`root_source\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
