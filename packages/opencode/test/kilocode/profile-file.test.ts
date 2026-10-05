import { expect, test } from "bun:test"
import { link, mkdtemp, open, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { database, read, regular } from "../../src/kilocode/migration/profile-file"

test("actual outside hardlink aliases refuse both selected data and SQLite sidecars", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-profile-file-"))
  const file = path.join(root, "selected.db")
  const alias = path.join(root, "outside-alias")
  await writeFile(file, "selected bytes")
  expect(await database(file)).toBe(await regular(file))
  await link(file, alias)
  await expect(regular(file)).rejects.toThrow("unique regular file")
  await expect(database(file)).rejects.toThrow("unique regular file")
  await unlink(alias)
  const sidecar = file + "-wal"
  await writeFile(sidecar, "sidecar bytes")
  await link(sidecar, alias)
  await expect(database(file)).rejects.toThrow("unique regular file")
  await unlink(alias)
  expect(await database(file)).toBe(await regular(file))
})

test("native file size admission refuses oversized sparse JSON before reading it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-profile-bounds-"))
  const file = path.join(root, "selected.json")
  await writeFile(file, '"café 日本語 😀"')
  const value = await read(file, 1024)
  expect(value.bytes).toBe(Buffer.byteLength(value.value))
  await expect(read(file, value.bytes - 1)).rejects.toThrow("supported size")
  const handle = await open(file, "r+")
  try {
    await handle.truncate(16_777_217)
  } finally {
    await handle.close()
  }
  await expect(read(file, 128 * 1024 * 1024)).rejects.toThrow("supported size")
})
