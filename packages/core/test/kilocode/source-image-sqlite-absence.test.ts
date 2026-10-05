import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { expect, test } from "bun:test"
import { NativeProcess } from "../../src/kilocode/process-host"
import { assertImage, withImage } from "../../src/kilocode/source-offline"
import { plan } from "../../src/kilocode/source-image-plan"

test.skipIf(process.platform !== "win32")(
  "held historical SQLite absence excludes companion files and creates no database",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "raya-sqlite-absence-"))
    const data = path.join(root, "data")
    await mkdir(data)
    const file = path.join(data, "historical.db")
    const roots = [{ kind: "sqlite" as const, path: file }]
    const policy = { version: 1 as const, directories: [data], files: [] }
    const executable = process.env.RAYA_OFFLINE_TEST_HELPER ?? (await NativeProcess.source())
    const digest = createHash("sha256")
      .update(await readFile(executable))
      .digest("hex")
    await withImage(
      { roots, policy, helper: { executable, digest }, registry: path.join(root, "registry") },
      async (image) => {
        const value = assertImage(image, roots)
        expect(value.roots[0].absence?.missing).toEqual([file, file + "-wal", file + "-shm"])
        expect(await readdir(value.roots[0].staged)).toEqual([])
        expect(value.files).toEqual([])
        for (const suffix of ["", "-wal", "-shm"])
          await assert.rejects(writeFile(file + suffix, "foreign", { flag: "wx" }))
      },
    )
    expect(await readdir(data)).toEqual([])
    await writeFile(file + "-wal", "orphan companion")
    await assert.rejects(plan(roots, policy), /companion file/)
    expect(await readdir(data)).toEqual(["historical.db-wal"])
  },
)
