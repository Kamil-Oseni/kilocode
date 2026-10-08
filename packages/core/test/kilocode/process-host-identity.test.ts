import assert from "node:assert/strict"
import { expect, test } from "bun:test"
import { copyFile, mkdtemp, readFile, writeFile, stat, utimes, rename, link, symlink } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { admission, synchronous } from "../../src/kilocode/process-host/identity"
import { request, synchronous as query } from "../../src/kilocode/process-host/request"
import { readFileSync, writeFileSync, utimesSync } from "node:fs"

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-helper-admission-"))
  const file = path.join(root, "raya-process-host.exe")
  await copyFile(path.resolve(import.meta.dir, "../../native/kilocode/bin/raya-process-host.exe"), file)
  return { root, file }
}

test("synchronous native identity joins actual protocol with unchanged helper bytes", async () => {
  const { file } = await fixture()
  const result = synchronous(file, () => query(file, ["inspect", String(process.pid)]))
  expect(result).toMatchObject({ status: "owned" })
})

test("synchronous native identity rejects same-size helper changes with restored mtime", async () => {
  const { file } = await fixture()
  const before = await stat(file)
  expect(() =>
    synchronous(file, () => {
      const result = query(file, ["--protocol"])
      const bytes = readFileSync(file)
      bytes[bytes.length - 1] ^= 1
      writeFileSync(file, bytes)
      utimesSync(file, before.atime, before.mtime)
      return result
    }),
  ).toThrow("changed during admission")
})

test("stalled synchronous read-only query is refused and its original child is joined", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-identity-query-deadline-"))
  const file = path.join(root, "query-pid")
  const started = performance.now()
  expect(() =>
    query(process.execPath, [
      "-e",
      `await Bun.write(${JSON.stringify(file)}, String(process.pid)); await Bun.sleep(30_000)`,
    ]),
  ).toThrow("identity query refused")
  expect(performance.now() - started).toBeLessThan(20_000)
  const pid = Number(await readFile(file, "utf8"))
  expect(Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid).toBe(true)
  expect(() => process.kill(pid, 0)).toThrow()
}, 25_000)

test("actual protocol accepts timestamp-only metadata changes with unchanged executable bytes", async () => {
  const { file } = await fixture()
  const before = await stat(file)
  const result = await admission(file, async () => {
    const value = await request(file, ["--protocol"])
    await utimes(file, new Date(), before.mtime)
    return value
  })
  expect(result).toMatchObject({ version: 1, proof: "windows-job" })
  expect((await stat(file)).ctimeMs).toBeGreaterThanOrEqual(before.ctimeMs)
})

test("actual protocol rejects same-size changed bytes despite restored modification time", async () => {
  const { file } = await fixture()
  const before = await stat(file)
  await assert.rejects(
    admission(file, async () => {
      const value = await request(file, ["--protocol"])
      const bytes = await readFile(file)
      bytes[bytes.length - 1] ^= 1
      await writeFile(file, bytes)
      await utimes(file, before.atime, before.mtime)
      return value
    }),
    /changed during admission/,
  )
})

test("actual protocol rejects replacement objects with identical bytes", async () => {
  const { root, file } = await fixture()
  const replacement = path.join(root, "replacement.exe")
  await copyFile(file, replacement)
  await assert.rejects(
    admission(file, async () => {
      const value = await request(file, ["--protocol"])
      await rename(file, path.join(root, "old.exe"))
      await rename(replacement, file)
      return value
    }),
    /changed during admission/,
  )
})

test("hardlinked helper objects refuse before protocol dispatch", async () => {
  const { root, file } = await fixture()
  await link(file, path.join(root, "alias.exe"))
  let calls = 0
  await assert.rejects(
    admission(file, async () => {
      calls++
      return 0
    }),
    /executable invalid/,
  )
  expect(calls).toBe(0)
})

test("directory alias retarget refuses even if new path has identical bytes", async () => {
  const { root, file } = await fixture()
  const other = path.join(root, "other")
  const { mkdir } = await import("node:fs/promises")
  await mkdir(other)
  await copyFile(file, path.join(other, "raya-process-host.exe"))
  const alias = path.join(root, "junction")
  await symlink(root, alias, "junction")
  const selected = path.join(alias, "raya-process-host.exe")
  await assert.rejects(
    admission(selected, async () => {
      const value = await request(selected, ["--protocol"])
      const { unlink } = await import("node:fs/promises")
      await unlink(alias)
      await symlink(other, alias, "junction")
      return value
    }),
    /changed during admission/,
  )
})

test("public source admission revalidates held identity even when protocol is cached", async () => {
  const { file } = await fixture()
  const { NativeProcess } = await import("../../src/kilocode/process-host")
  expect(await NativeProcess.source(file)).toBe(file)
  const before = await stat(file)
  await utimes(file, new Date(), before.mtime)
  expect(await NativeProcess.source(file)).toBe(file)
  const alias = path.join(path.dirname(file), "second-link.exe")
  await link(file, alias)
  await assert.rejects(NativeProcess.source(file), /executable invalid/)
})
