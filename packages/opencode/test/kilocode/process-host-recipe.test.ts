import assert from "node:assert/strict"
import { expect, test } from "bun:test"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { recipe } from "../../script/kilocode/process-host"

test("native recipe authenticates diagnostic include changes and refuses its absence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-native-recipe-"))
  const repo = path.resolve(import.meta.dir, "../../../..")
  const names = [
    "packages/opencode/script/kilocode/process-host.ts",
    "packages/core/native/kilocode/process-host.cpp",
    "packages/core/native/kilocode/source-host.inc",
    "packages/core/native/kilocode/source-diagnostic.inc",
    "packages/core/native/kilocode/source-pipe.inc",
    "packages/core/native/kilocode/profile-offline.inc",
    "packages/core/script/kilocode/build-process-host.ps1",
  ]
  try {
    await Promise.all(
      names.map(async (name) => {
        const file = path.join(root, name)
        await mkdir(path.dirname(file), { recursive: true })
        await copyFile(path.join(repo, name), file)
      }),
    )
    const module = await import(pathToFileURL(path.join(root, names[0])).href)
    const before = await module.recipe()
    expect(before).toBe(await recipe())
    const file = path.join(root, "packages/core/native/kilocode/source-diagnostic.inc")
    await writeFile(file, Buffer.concat([await readFile(file), Buffer.from("\n// recipe regression\n")]))
    expect(await module.recipe()).not.toBe(before)
    await rm(file)
    await assert.rejects(module.recipe(), { code: "ENOENT" })
  } finally {
    await rm(root, { recursive: true })
  }
})
