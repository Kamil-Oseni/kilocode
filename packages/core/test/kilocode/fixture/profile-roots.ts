import { ManagedRuntime, Schema } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { layer } from "../../../src/database/sqlite.bun"
import { Sqlite } from "../../../src/database/sqlite"
import { ProfileRoots } from "../../../src/kilocode/profile-roots"
import { admitProfileOperation, resolveProfileRoot } from "../../../src/kilocode/profile-maintenance"
import { profileSqlite } from "../../../src/kilocode/profile-sqlite"
import { Flock } from "../../../src/util/flock"
import { createSequencer } from "../../../../opencode/src/kilocode/session-export/sequence"

const input = Schema.decodeUnknownSync(Schema.Struct({ dir: Schema.String }))(JSON.parse(process.argv[2]))
if (ProfileRoots.snapshot().length) throw new Error("Fresh process inventory is not empty")
const primary = path.join(input.dir, "core", "primary.db")
const external = path.join(input.dir, "external", "export.db")
const json = path.join(input.dir, "json")
await Promise.all([fs.mkdir(path.dirname(primary)), fs.mkdir(path.dirname(external)), fs.mkdir(json)])
const unused = path.join(input.dir, "unused.db")
const first = ManagedRuntime.make(layer({ filename: primary }))
const second = ManagedRuntime.make(layer({ filename: primary }))
const lazy = ManagedRuntime.make(layer({ filename: unused }))
if (ProfileRoots.snapshot().length) throw new Error("Unused graphs invented profile roots")
await first.runPromise(Sqlite.Native)
await second.runPromise(Sqlite.Native)
const sequence = createSequencer(external)
sequence.next("fixture")
const lease = admitProfileOperation({ kind: "json", path: json })
try {
  await fs.writeFile(path.join(json, "value.json"), JSON.stringify({ value: "admitted" }))
} finally {
  lease.release()
}
const before = ProfileRoots.snapshot()
await Promise.all([first.dispose(), second.dispose(), lazy.dispose()])
sequence.close()
const closed = ProfileRoots.snapshot()
const next = path.join(input.dir, "core", "next.db")
const generation = ManagedRuntime.make(layer({ filename: next }))
await generation.runPromise(Sqlite.Native)
await generation.dispose()
const failed = path.join(input.dir, "core", "failed.db")
try {
  profileSqlite(failed, () => {
    throw new Error("Opaque native factory failure")
  })
} catch (err) {
  if (!(err instanceof Error) || err.message !== "Opaque native factory failure") throw err
}
const denied = await resolveProfileRoot({ kind: "sqlite", path: path.join(input.dir, "denied.db") })
await Flock.withLock(
  denied.id,
  async () => {
    try {
      admitProfileOperation(denied)
      throw new Error("Unexpected admission under gate")
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes("maintenance excludes")) throw err
    }
  },
  { dir: path.join(input.dir, ".raya-profile-locks"), recover: false },
)
console.log(
  JSON.stringify({
    primary,
    external,
    json,
    unused,
    next,
    failed,
    denied: denied.path,
    before,
    closed,
    final: ProfileRoots.snapshot(),
    unusedExists: await fs.stat(unused).then(
      () => true,
      () => false,
    ),
    portableCaptureAuthorized: false,
  }),
)
