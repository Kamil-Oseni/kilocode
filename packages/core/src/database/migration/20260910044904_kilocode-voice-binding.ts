import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260910044904_kilocode-voice-binding",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`raya_voice_binding\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_raya_voice_binding_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`raya_voice_binding_session_idx\` ON \`raya_voice_binding\` (\`session_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
