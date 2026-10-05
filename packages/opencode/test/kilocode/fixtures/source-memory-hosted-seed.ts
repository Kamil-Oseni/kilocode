import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { lstat, readFile, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { MemoryFiles } from "@kilocode/kilo-memory/store"
import { MemoryPaths } from "@kilocode/kilo-memory/paths"
import { MemorySchema } from "@kilocode/kilo-memory/schema"
import { closeProcessProfile, processProfileSnapshot } from "@opencode-ai/core/kilocode/process-profile"
import { NativeProcess } from "@opencode-ai/core/kilocode/process-host/index"
import { installMemoryRuntime } from "../../../src/kilocode/memory/runtime"
import { KiloShutdown } from "../../../src/kilocode/cli/shutdown"
import { ProfileWriterLive } from "../../../src/kilocode/migration/writer-live"
import { seed } from "./source-memory-quarantine-assert"

const [root, workspace, report, helper] = process.argv.slice(2)
assert(
  root && workspace && report && helper && [root, workspace, report, helper].every((file) => path.isAbsolute(file)),
)
installMemoryRuntime()
assert(MemoryFiles.hosted())
const inspected = await NativeProcess.inspect(process.pid, helper)
assert(inspected && typeof inspected === "object" && "status" in inspected && inspected.status === "owned")
assert("birth" in inspected)
const owner = {
  pid: process.pid,
  birth: inspected.birth,
  executable: process.execPath,
  digest: createHash("sha256")
    .update(await readFile(process.execPath))
    .digest("hex"),
  nativeBirthInspected: true,
}
assert.equal(owner.pid, process.pid)
assert(typeof owner.birth === "string" && /^\d+$/.test(owner.birth))
const id = MemoryPaths.declared(workspace)
const dir = path.join(root, "data", "kilo", "memory", id.folder)
await MemoryFiles.scaffold(dir, id)
await MemoryFiles.writeState(dir, MemorySchema.create())
await MemoryFiles.writeSource(dir, "project.md", "SOURCE_MEMORY_EXACT café 日本語 😀\n")
await MemoryFiles.writeSource(dir, "environment.md", "SOURCE_MEMORY_ENV\n")
await MemoryFiles.writeSource(dir, "corrections.md", "SOURCE_MEMORY_CORRECTION\n")
await MemoryFiles.writeSession(dir, {
  sessionID: "source-memory-historical",
  summary: "SOURCE_MEMORY_SESSION café 日本語 😀",
  max: 10000,
  time: 1000,
})
const backups = await seed(dir)
const files: { path: string; bytes: number; digest: string; dev: string; ino: string }[] = []
async function collect(base: string) {
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (entry.name === ".raya-profile-locks") continue
    const file = path.join(base, entry.name)
    assert(!entry.isSymbolicLink())
    if (entry.isDirectory()) {
      await collect(file)
      continue
    }
    const info = await lstat(file, { bigint: true })
    assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1n)
    const raw = await readFile(file)
    files.push({
      path: file,
      bytes: raw.length,
      digest: createHash("sha256").update(raw).digest("hex"),
      dev: String(info.dev),
      ino: String(info.ino),
    })
    assert(files.length <= 128)
  }
}
await collect(dir)
const before = processProfileSnapshot()
const markers = []
for (const file of before.roots) {
  assert(!path.relative(root, file).startsWith(".."))
  const key = path.normalize(file).toLowerCase()
  const folder = createHash("sha1").update(`raya.profile.json:${key}`).digest("hex") + ".owners"
  const base = path.join(path.dirname(file), ".raya-profile-locks", folder)
  const matches = []
  for (const name of await readdir(base)) {
    const marker = path.join(base, name)
    const raw = await readFile(marker)
    const value = JSON.parse(raw.toString())
    if (value.pid !== process.pid) continue
    assert.equal(value.format, "raya.profile-native-owner")
    assert.equal(value.root, key)
    assert.equal(value.token + ".json", name)
    const info = await lstat(marker, { bigint: true })
    assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1n)
    matches.push({
      path: marker,
      bytes: raw.length,
      digest: createHash("sha256").update(raw).digest("hex"),
      dev: String(info.dev),
      ino: String(info.ino),
    })
  }
  assert.equal(matches.length, 1)
  markers.push(...matches)
}
assert(markers.length > 0)
await KiloShutdown.run()
const writers = Effect.runSync(ProfileWriterLive.snapshot)
assert.equal(writers.active.find((entry) => entry.id === "profile.data.memory")?.count ?? 0, 0)
await closeProcessProfile()
const after = processProfileSnapshot()
assert.equal(after.terminal, true)
assert.equal(after.failures, 0)
assert.deepEqual(after.roots, [])
for (const marker of markers) assert.equal(await Bun.file(marker.path).exists(), false)
const metadata: { path: string; entries: number; dev: string; ino: string }[] = []
async function empty(base: string) {
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    assert(!entry.isSymbolicLink())
    const file = path.join(base, entry.name)
    if (/^[a-f0-9]{40}\.(owners|writers)$/.test(entry.name) || entry.name === "covered.references") {
      const names = await readdir(file)
      assert.deepEqual(names, [])
      const info = await lstat(file, { bigint: true })
      metadata.push({ path: file, entries: names.length, dev: String(info.dev), ino: String(info.ino) })
      continue
    }
    await empty(file)
  }
}
await empty(root)
for (const file of files) {
  const raw = await readFile(file.path)
  const info = await lstat(file.path, { bigint: true })
  assert.equal(raw.length, file.bytes)
  assert.equal(createHash("sha256").update(raw).digest("hex"), file.digest)
  assert.equal(String(info.dev), file.dev)
  assert.equal(String(info.ino), file.ino)
}
for (const value of backups)
  assert.equal(
    createHash("sha256")
      .update(await readFile(value.source))
      .digest("hex"),
    value.digest,
  )
await writeFile(
  report,
  JSON.stringify({
    owner,
    hosted: true,
    before,
    after,
    writers,
    markers,
    files,
    metadata,
    backups,
    shutdownJoined: true,
    profileClosed: true,
  }),
  { flag: "wx", mode: 0o600 },
)
