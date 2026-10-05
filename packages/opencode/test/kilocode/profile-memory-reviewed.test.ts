import assert from "node:assert/strict"
import { expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { MemoryFiles } from "@kilocode/kilo-memory/store"
import { MemoryPaths } from "@kilocode/kilo-memory/paths"
import { MemorySchema } from "@kilocode/kilo-memory/schema"
import { memory, memories } from "../../src/kilocode/migration/profile-memory"
import { memoryState } from "../../src/kilocode/migration/profile-memory-lineage"

test("genuine destination reviewed state remains lossless inert memory evidence", async () => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-reviewed-memory-")))
  const data = path.join(dir, "data")
  const workspace = path.join(dir, "workspace")
  await mkdir(workspace)
  const id = MemoryPaths.declared(workspace)
  const root = path.join(data, "memory", id.folder)
  await MemoryFiles.scaffold(root, id)
  const hold = { version: 1, id: randomUUID(), state: "held", createdAt: Date.now() }
  await mkdir(path.join(data, "storage", "raya"), { recursive: true })
  await writeFile(path.join(data, "storage", "raya", "restore-hold.json"), JSON.stringify(hold))
  await writeFile(
    path.join(root, "restore.json"),
    JSON.stringify({ format: "raya.restored-memory", version: 1, hold: hold.id }),
  )
  const state = { ...MemorySchema.create(), enabled: true }
  await MemoryFiles.writeState(root, state)
  const bytes = await readFile(path.join(root, "state.json"), "utf8")
  const raw: unknown = JSON.parse(bytes)
  // This is the real writer/parser disagreement that previously discarded reviewed state claims.
  expect(MemorySchema.persist(MemorySchema.parse(raw)).autoInject).toBe(true)
  const parsed = memoryState.parse(raw)
  expect(parsed.autoInject).toBe(false)
  expect(parsed.enabled).toBe(false)
  expect(parsed.autoConsolidate).toBe(false)
  expect(parsed.capture.turnClose).toBe(false)
  const values = await memories(path.join(data, "memory"), path.join(data, "memory"))
  expect(JSON.parse(values[0].state).autoInject).toBe(false)
  expect(
    values[0].lineage?.records.some((item) => item.sourceDigest === createHash("sha256").update(bytes).digest("hex")),
  ).toBe(true)
  expect(memory.parse(values[0]).state).toBe(values[0].state)
  expect(values[0].review?.activation).toBe("inert")
  expect(values[0].review?.marker.hold).toBe(hold.id)
  expect(values[0].review?.receipt.review).toBeUndefined()
  const changed = structuredClone(values[0])
  changed.review!.marker.hold = randomUUID()
  assert.throws(() => memory.parse(changed))
  expect((await MemoryFiles.readState(root)).autoInject).toBe(false)
  assert.throws(() => memoryState.parse({ ...parsed, unknown: true }))
  assert.throws(() => memoryState.parse({ ...parsed, capture: { ...parsed.capture, timeoutMs: 0 } }))
  await writeFile(
    path.join(root, "restore.json"),
    JSON.stringify({ format: "raya.restored-memory", version: 1, hold: randomUUID() }),
  )
  await assert.rejects(MemoryFiles.readState(root), /review identity differs/)
  await assert.rejects(memories(path.join(data, "memory"), path.join(data, "memory")), /review identity differs/)
})
