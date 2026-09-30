import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260930134923_kilocode-composer-drafts",
  up(tx) {
    return Effect.gen(function* () {
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
      yield* tx.run(`CREATE UNIQUE INDEX \`raya_composer_identity\` ON \`raya_composer_draft\` (\`id\`);`)
      yield* tx.run(
        `CREATE INDEX \`raya_composer_catalog\` ON \`raya_composer_draft\` (\`workspace\`,\`project\`,\`box\`,\`sequence\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
