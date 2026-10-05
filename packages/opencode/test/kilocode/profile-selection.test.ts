import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, realpath, link } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { select } from "../../src/kilocode/migration/profile-selection"

test("custom database selection retains actual data, archive and preference namespaces", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-selection-")))
  const data = path.join(root, "data")
  const storage = path.join(data, "storage")
  const config = path.join(root, "config")
  const sql = path.join(root, "sql")
  await Promise.all([mkdir(storage, { recursive: true }), mkdir(config), mkdir(sql)])
  const database = path.join(sql, "raya.db")
  const archive = path.join(data, "session-export.db")
  const preference = path.join(config, "model.json")
  await Promise.all([
    writeFile(database, "private database"),
    writeFile(archive, "private archive"),
    writeFile(preference, "{}"),
  ])
  const input = { database, storage, preferences: { modelState: preference } }
  const policy = { version: 1 as const, directories: [data, config, sql], files: [] }
  const selected = await select(input, policy)
  expect(selected.profile.data).toBe(data)
  expect(selected.profile.exports).toBe(archive)
  expect(selected.profile.preferences.modelState).toBe(preference)
  expect(selected.roots).toContainEqual({ kind: "json", path: data })
  expect(selected.roots).toContainEqual({ kind: "json", path: config })
  expect(selected.roots).toContainEqual({ kind: "sqlite", path: archive })
  expect(Object.isFrozen(selected.roots)).toBe(true)
  await assert.rejects(select(input, { ...policy, directories: [storage, config, sql] }), /producer policy/)
  await assert.rejects(select(input, { ...policy, directories: [data, sql], files: [preference] }), /producer policy/)
  await link(preference, path.join(root, "outside-model.json"))
  await assert.rejects(select(input, policy), /unsupported/)
})

test("absent default archive is allowed but an explicitly missing archive refuses", async () => {
  const data = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-selection-missing-")))
  const storage = path.join(data, "storage")
  const database = path.join(data, "raya.db")
  await mkdir(storage)
  await writeFile(database, "private database")
  const policy = { version: 1 as const, directories: [data], files: [] }
  const selected = await select({ database, storage }, policy)
  expect(selected.profile.exports).toBeUndefined()
  await assert.rejects(select({ database, storage, exports: path.join(data, "missing.db") }, policy))
})
