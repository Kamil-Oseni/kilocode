import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { copyFile, mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { Database } from "bun:sqlite"
import { ManagedRuntime } from "effect"
import { Database as Core } from "@opencode-ai/core/database/database"
import { withImage } from "@opencode-ai/core/kilocode/source-offline"
import { withWorking } from "../../../src/kilocode/migration/profile-image"
import { bindSQL, sqlGroups, validateSQL } from "../../../src/kilocode/migration/profile-sql-correspondence"
import { tables } from "../../../src/kilocode/migration/profile-bundle"
import { seedAllocator } from "./source-sql-allocator-seed"
import { finish } from "../../../src/kilocode/cli/finish"

const root = process.argv[2]
const data = path.join(root, "data")
const storage = path.join(data, "storage")
const file = path.join(data, "raya.db")
await mkdir(storage, { recursive: true })
const runtime = ManagedRuntime.make(Core.layerFromPath(file))
const seeded = await runtime.runPromise(seedAllocator).finally(() => runtime.dispose())
assert.equal(seeded.rows[0].seq, 1)
assert.equal(seeded.highwater, 0)
const helper = path.join(root, "raya-process-host.exe")
await copyFile(path.resolve(import.meta.dir, "../../../../core/native/kilocode/bin/raya-process-host.exe"), helper)
const roots = [
  { kind: "json" as const, path: data },
  { kind: "json" as const, path: storage },
  { kind: "sqlite" as const, path: file },
]
const policy = { version: 1 as const, directories: [data], files: [] }
const selected = { roots, profile: { database: file, data, storage, preferences: {}, exports: undefined } }
await withImage(
  {
    roots,
    policy,
    inventory: "directories",
    registry: path.join(root, "registry"),
    helper: {
      executable: helper,
      digest: createHash("sha256")
        .update(await readFile(helper))
        .digest("hex"),
    },
  },
  (image) =>
    withWorking(image, selected, async (token) => {
      const { assertWorking } = await import("../../../src/kilocode/migration/profile-image")
      const working = assertWorking(token)
      const reader = new Database(working.profile.database, { readonly: true, strict: true })
      try {
        const sql = tables.map((table) => ({
          table,
          columns: reader
            .query<{ name: string }, []>(`PRAGMA table_info('${table}')`)
            .all()
            .map((item) => item.name),
          rows: reader.query(`SELECT * FROM "${table}"`).values(),
        }))
        const claim = await bindSQL(token, { sql })
        const group = sqlGroups(token, claim)[0]
        assert.deepEqual(group.allocator?.rows, [{ name: "raya_composer_draft", seq: 1, highwater: 0 }])
        assert.equal(
          group.tables.find((item) => item.table === "sqlite_sequence")?.disposition,
          "inactive-allocator-counters",
        )
        validateSQL(group, { sql })
        assert.equal(group.allocator?.installation, false)
        await Bun.write(
          path.join(root, "receipt.json"),
          JSON.stringify({
            passed: true,
            actualCore: true,
            heldNative: true,
            deletedHighwater: true,
            installation: false,
            portableCaptureAuthorized: false,
          }),
        )
      } finally {
        reader.close()
      }
    }),
)
await finish([])
