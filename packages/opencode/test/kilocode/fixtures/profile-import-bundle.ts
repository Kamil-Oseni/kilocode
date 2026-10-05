import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { Database as Native } from "bun:sqlite"
import { Effect, ManagedRuntime } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { payload, seal, tables } from "../../../src/kilocode/migration/profile-bundle"
import { signature, type Column } from "../../../src/kilocode/migration/profile-restore"
import { finish } from "../../../src/kilocode/cli/finish"

const root = process.argv[2]
assert.ok(root)
const workspace = path.join(root, "source-workspace")
await mkdir(workspace)
const file = path.join(root, "producer", "source.db")
const runtime = ManagedRuntime.make(Database.layerFromPath(file))
const schema = await runtime.runPromise(
  Effect.gen(function* () {
    const service = yield* Database.Service
    const dir = workspace.replaceAll("\\", "/").replaceAll("'", "''")
    yield* service.db.run(
      "INSERT INTO project(id,worktree,time_created,time_updated,sandboxes) VALUES ('global','/',1,1,'[]')",
    )
    yield* service.db.run(
      `INSERT INTO session(id,project_id,slug,directory,path,title,version,time_created,time_updated) VALUES ('ses_import_fixture','global','import','${dir}','','Imported actual chat','1',1,1)`,
    )
    yield* service.db.run(
      "INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES ('msg_import_fixture','ses_import_fixture',1,1,'{\"role\":\"assistant\"}')",
    )
    yield* service.db.run(
      "INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES ('prt_import_fixture','msg_import_fixture','ses_import_fixture',1,1,'{\"type\":\"text\",\"text\":\"IMPORT_CAFÉ_日本語_😀\"}')",
    )
    return yield* signature((query) => service.db.all<Column>(query))
  }),
)
await runtime.dispose()
const db = new Native(file, { readonly: true })
try {
  const value = {
    format: "raya.profile-data" as const,
    version: 1 as const,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    schema,
    workspaces: [workspace],
    sql: tables.map((table) => ({
      table,
      columns: db
        .query<Column, []>(`PRAGMA table_info('${table}')`)
        .all()
        .map((column) => column.name),
      rows: db.query(`SELECT * FROM "${table}"`).values(),
    })),
    json: [
      {
        path: "raya/agent.json",
        value: JSON.stringify([
          {
            id: "agent",
            name: "Imported worker",
            role: "generalist",
            objective: "Require explicit enable",
            capabilities: [],
            memoryScope: "role",
            schedule: { kind: "once", at: 1 },
            scheduleVersion: 1,
            scheduleUpdatedAt: 1,
            enabled: true,
            dir: workspace,
            tools: [],
            access: "brief",
            createdAt: 1,
            updatedAt: 1,
          },
        ]),
      },
    ],
    review: { reconnectCredentials: true as const, uncertainWork: "held-no-replay" as const },
  }
  await writeFile(path.join(root, "profile.raya"), await seal(payload.parse(value), "é".repeat(6)))
  console.log("PROFILE_IMPORT_BUNDLE_READY")
} finally {
  db.close()
}
await finish([])
