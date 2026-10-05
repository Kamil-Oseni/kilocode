import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { CacheManager } from "../../../src/indexing/cache-manager"

test("accepted actual cache publication joins terminal close and rejects later timer mutations", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "raya-cache-close-"))
  const workspace = path.join(root, "workspace")
  const cache = new CacheManager(root, workspace)
  await cache.initialize()
  cache.updateHash("actual.ts", "accepted")
  const flushed = cache.flush()
  const closed = cache.dispose()
  expect(cache.dispose()).toBe(closed)
  expect(() => cache.updateHash("late.ts", "late")).toThrow(/closed/)
  await expect(cache.flush()).rejects.toThrow(/closed/)
  await Promise.all([flushed, closed])
  const file = path.join(root, `roo-index-cache-${createHash("sha256").update(workspace).digest("hex")}.json`)
  expect(await Bun.file(file).json()).toEqual({ "actual.ts": "accepted" })
  const before = await fs.stat(file)
  await Bun.sleep(1600)
  expect((await fs.stat(file)).mtimeMs).toBe(before.mtimeMs)
})

test("actual failed cache rename remains sticky after its obstruction is repaired", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "raya-cache-failure-"))
  const workspace = path.join(root, "workspace")
  const cache = new CacheManager(root, workspace)
  await cache.initialize()
  const file = path.join(root, `roo-index-cache-${createHash("sha256").update(workspace).digest("hex")}.json`)
  await fs.mkdir(file)
  cache.updateHash("actual.ts", "accepted")
  await expect(cache.flush()).rejects.toThrow()
  await fs.rmdir(file)
  await expect(cache.dispose()).rejects.toThrow(/unconfirmed/)
  expect(await Bun.file(file).json()).toEqual({ "actual.ts": "accepted" })
})
