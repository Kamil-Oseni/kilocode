import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { mkdtemp, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { read } from "../../src/kilocode/source-readiness"

const helper = path.resolve(import.meta.dir, "../../native/kilocode/bin/raya-process-host.exe")

test("absent readiness never reaches an invalid native helper", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-readiness-"))
  for (let n = 0; n < 12; n++)
    expect(await read(path.join(root, "absent.json"), path.join(root, "not-a-helper"), true)).toBeUndefined()
})

test("non-ENOENT probe errors propagate before native admission", async () => {
  await assert.rejects(read("invalid\0path", "not-a-helper", true), { code: "ERR_INVALID_ARG_VALUE" })
})

test("delayed readiness switches from absent hint to actual native held metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-readiness-"))
  const file = path.join(root, "delayed.json")
  const signal = Promise.withResolvers<void>()
  const saved = signal.promise.then(() => writeFile(file, '{"generation":2}'))
  expect(await read(file, helper, true)).toBeUndefined()
  signal.resolve()
  await saved
  expect(await read(file, helper, true)).toEqual({ generation: 2 })
})

test("present readiness retains actual native positive read and JSON validation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-readiness-"))
  const file = path.join(root, "ready.json")
  await writeFile(file, '{"ready":true}')
  expect(await read(file, helper, true)).toEqual({ ready: true })
  expect(await read(file, helper)).toEqual({ ready: true })
  await writeFile(file, "invalid")
  await assert.rejects(read(file, helper, true), SyntaxError)
})

test("an existing nonfile cannot be treated as absent readiness", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-readiness-"))
  await assert.rejects(read(root, helper, true))
})

test("a present directory junction still requires native no-link authority", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-readiness-"))
  const alias = path.join(root, "alias")
  await symlink(root, alias, "junction")
  await assert.rejects(read(alias, helper, true))
})

test("unprobed absent reads still require actual native helper admission", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-readiness-"))
  await assert.rejects(read(path.join(root, "absent.json"), path.join(root, "not-a-helper")), /path invalid/)
})
