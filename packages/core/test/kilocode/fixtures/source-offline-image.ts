import { Database } from "bun:sqlite"
import { NativeProcess } from "../../../src/kilocode/process-host"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, writeFile, cp, open, link, readdir, symlink, rename } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { withImage, assertImage, recoverPending, startup } from "../../../src/kilocode/source-offline"

const root = await mkdtemp(path.join(os.tmpdir(), "raya-offline-api-"))
const data = path.join(root, "data")
const live = path.join(root, "live")
await Promise.all([mkdir(data), mkdir(live)])
const db = new Database(path.join(live, "raya.db"))
db.exec(
  "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES('durable-wal')",
)
for (const suffix of ["", "-wal", "-shm"])
  await cp(path.join(live, "raya.db") + suffix, path.join(data, "raya.db") + suffix)
db.close()
await writeFile(path.join(data, "raw.bin"), Buffer.from([0, 254, 13, 27]))
await mkdir(path.join(data, "nested"))
await writeFile(path.join(data, "nested", "preserved.json"), '{"inert":true}')
const database = path.join(data, "raya.db")
const helper = await NativeProcess.source()
const digest = createHash("sha256")
  .update(await readFile(helper))
  .digest("hex")
const policy = { version: 1 as const, directories: [data], files: [] }
const roots = [
  { kind: "sqlite" as const, path: database },
  { kind: "json" as const, path: data },
]
const hashes = await Promise.all(
  ["", "-wal", "-shm"].map(async (suffix) =>
    createHash("sha256")
      .update(await readFile(database + suffix))
      .digest("hex"),
  ),
)
let retained: unknown
const first = await withImage(
  { registry: path.join(root, "registry"), roots, policy, helper: { executable: helper, digest } },
  async (image) => {
    retained = image
    const value = assertImage(image, roots)
    if (value.roots.length !== 2 || !value.files.some((file) => file.original.endsWith("-wal")))
      throw new Error("WAL/mapping missing")
    let mutation = false
    try {
      await writeFile(value.files[0].staged, "wrong")
    } catch {
      mutation = true
    }
    if (!mutation) throw new Error("Raw stage accepted mutation")
    const stage = value.roots[1].staged
    const blocked: boolean[] = []
    for (const file of [
      path.join(stage, "new.json"),
      path.join(stage, "nested", "new.json"),
      path.join(path.dirname(value.roots[0].staged), "new.json"),
      path.join(value.control, "image", "new.json"),
    ]) {
      try {
        await writeFile(file, "{}")
        blocked.push(false)
      } catch {
        blocked.push(true)
      }
    }
    try {
      await rename(stage, stage + "-moved")
      blocked.push(false)
    } catch {
      blocked.push(true)
    }
    try {
      await rename(path.join(stage, "nested"), path.join(stage, "nested-moved"))
      blocked.push(false)
    } catch {
      blocked.push(true)
    }
    if (blocked.length !== 6 || blocked.some((value) => !value))
      throw new Error("Raw stage namespace accepted creation/rename")
    let forge = false
    try {
      assertImage(JSON.parse(JSON.stringify(value)), roots)
    } catch {
      forge = true
    }
    if (!forge) throw new Error("Serialized metadata authorized image")
    const working = path.join(value.control, "working")
    await mkdir(working)
    const staged = value.roots[0].staged
    for (const suffix of ["", "-wal", "-shm"]) await cp(staged + suffix, path.join(working, "raya.db") + suffix)
    const recovered = new Database(path.join(working, "raya.db"))
    const row = recovered.query<{ value: string }, []>("SELECT value FROM evidence").get()
    recovered.close()
    if (!row || row.value !== "durable-wal") throw new Error("Staged WAL recovery lost committed row")
    return {
      row: row.value,
      mappingCount: value.roots.length,
      recordCount: value.files.length,
      mutation,
      rawNamespaceBlocked: blocked,
      forge,
    }
  },
)
let expired = false
try {
  assertImage(retained, roots)
} catch {
  expired = true
}
if (!expired) throw new Error("Callback image remained active")
const after = await Promise.all(
  ["", "-wal", "-shm"].map(async (suffix) =>
    createHash("sha256")
      .update(await readFile(database + suffix))
      .digest("hex"),
  ),
)
if (JSON.stringify(hashes) !== JSON.stringify(after)) throw new Error("Original SQLite/WAL/SHM changed")
const failure = new Error("actual callback failure")
let retainedFailure = false
try {
  await withImage(
    {
      registry: path.join(root, "registry"),
      roots: [{ kind: "json", path: data }],
      policy,
      helper: { executable: helper, digest },
    },
    async () => {
      throw failure
    },
  )
} catch (err) {
  retainedFailure = err instanceof AggregateError && err.errors.includes(failure)
}
if (!retainedFailure) throw new Error("Callback failure was lost")
await writeFile(path.join(data, "after-failure.txt"), "rollback restored")
const single = await withImage(
  {
    registry: path.join(root, "registry"),
    roots: [{ kind: "json", path: path.join(data, "raw.bin") }],
    policy,
    helper: { executable: helper, digest },
  },
  async (image) => {
    const value = assertImage(image, [{ kind: "json", path: path.join(data, "raw.bin") }])
    if (
      value.roots[0].directory ||
      value.files.length !== 1 ||
      !(await readFile(value.roots[0].staged)).equals(Buffer.from([0, 254, 13, 27]))
    )
      throw new Error("Regular-file JSON namespace copied parent tree or changed bytes")
    return true
  },
)
const writer = await open(path.join(data, "raw.bin"), "r+")
let refused = false
let invoked = false
const preparation: string[] = []
try {
  await withImage(
    {
      registry: path.join(root, "registry"),
      roots: [{ kind: "json", path: data }],
      policy,
      helper: { executable: helper, digest },
    },
    async () => {
      invoked = true
    },
  )
} catch (err) {
  refused = err instanceof AggregateError
  if (err instanceof AggregateError)
    for (const cause of err.errors)
      if (cause instanceof AggregateError)
        for (const value of cause.errors)
          if (value instanceof Error && "code" in value && typeof value.code === "string") preparation.push(value.code)
} finally {
  await writer.close()
}
if (!refused || invoked) throw new Error("Accepted writable handle did not refuse acquisition")
if (!preparation.includes("RAYA_OFFLINE_EXCLUSIVE_SOURCE_HANDLE_REFUSED"))
  throw new Error("Native preparation refusal code was lost")
await writeFile(path.join(data, "after-refusal.txt"), "rollback restored")
const outside = path.join(root, "outside")
await mkdir(outside)
let unclassified = false
try {
  await withImage(
    {
      registry: path.join(root, "registry"),
      roots: [{ kind: "json", path: outside }],
      policy,
      helper: { executable: helper, digest },
    },
    async () => {
      throw new Error("Outside-policy callback ran")
    },
  )
} catch (err) {
  unclassified = err instanceof Error && err.message.includes("outside policy")
}
if (!unclassified) throw new Error("Unclassified root was not refused")
await link(path.join(data, "raw.bin"), path.join(data, "hardlink.bin"))
let linked = false
try {
  await withImage(
    {
      registry: path.join(root, "registry"),
      roots: [{ kind: "json", path: data }],
      policy,
      helper: { executable: helper, digest },
    },
    async () => {
      throw new Error("Hardlinked source callback ran")
    },
  )
} catch (err) {
  linked = err instanceof AggregateError
}
if (!linked) throw new Error("Nested hardlink did not refuse capture")
await writeFile(path.join(data, "after-hardlink-refusal.txt"), "rollback restored")
const reparse = path.join(root, "reparse")
await mkdir(reparse)
await symlink(outside, path.join(reparse, "escape"), "junction")
let escaped = false
try {
  await withImage(
    {
      registry: path.join(root, "registry"),
      roots: [{ kind: "json", path: reparse }],
      policy: { version: 1, directories: [reparse], files: [] },
      helper: { executable: helper, digest },
    },
    async () => {
      throw new Error("Nested reparse callback ran")
    },
  )
} catch (err) {
  escaped = err instanceof AggregateError
}
if (!escaped) throw new Error("Nested native junction did not refuse capture")
await writeFile(path.join(reparse, "after-refusal.txt"), "rollback restored")
const directory = path.join(root, "registry")
const entries = await readdir(directory)
const journal = path.join(directory, entries[0], "journal.bin")
const original = await readFile(journal)
const changed = Buffer.from(original)
changed[Math.floor(changed.length / 2)] ^= 1
await writeFile(journal, changed)
let authenticated = false
try {
  await recoverPending(directory, { executable: helper, digest })
} catch (err) {
  authenticated = err instanceof Error && err.message.includes("authenticated journal refused")
}
if (!authenticated) throw new Error("Tampered DPAPI recovery journal accepted")
await writeFile(journal, original)
const recovered = await recoverPending(directory, { executable: helper, digest })
if (recovered.length !== 6) throw new Error("Stable registry omitted a retained generation")
const repeated = await startup({ registry: directory, helper: { executable: helper, digest } })
if (repeated.length !== 6) throw new Error("Restored registry generations were not idempotent")
const missing = await startup({
  registry: path.join(root, "never-created"),
  helper: { executable: path.join(root, "missing-helper.exe"), digest: "0".repeat(64) },
})
if (missing.length) throw new Error("Unused registry produced invented recovery")
await writeFile(path.join(directory, "unknown.txt"), "uncertain")
let unknown = false
try {
  await recoverPending(directory, { executable: helper, digest })
} catch (err) {
  unknown = err instanceof Error && err.message.includes("unknown entry")
}
if (!unknown) throw new Error("Unknown registry participant accepted")
console.log(
  JSON.stringify(
    {
      root,
      first,
      expired,
      sourceHashesUnchanged: true,
      retainedFailure,
      rollbackWritable: true,
      regularFileRoot: single,
      existingWriteRefused: refused,
      preparation,
      callbackNeverEntered: !invoked,
      unclassified,
      hardlinkRefused: linked,
      junctionRefused: escaped,
      authenticatedJournalTamperRefused: authenticated,
      recoveredGenerations: recovered.length,
      repeatedStartupGenerations: repeated.length,
      unusedRegistryRealizedNoHelper: missing.length === 0,
      unknownRegistryEntryRefused: unknown,
      portableCaptureAuthorized: false,
    },
    null,
    2,
  ),
)
