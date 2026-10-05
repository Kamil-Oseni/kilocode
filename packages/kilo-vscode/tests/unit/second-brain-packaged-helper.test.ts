import { expect, test } from "bun:test"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ProcessHost, recipe } from "../../../opencode/script/kilocode/process-host"
import { packaged } from "../../src/second-brain/control/index"

test("Memory accepts the current authenticated native producer and its actual x64 protocol", async () => {
  const root = path.resolve(".")
  const helper = await packaged(root)
  const metadata = JSON.parse(await readFile(path.join(root, "bin/raya-process-host.json"), "utf8"))
  expect(metadata.recipe).toBe(await recipe())
  expect(metadata.exe).toBe(helper.files[0].digest)
  expect(metadata.pdb).toBe(helper.files[1].digest)
  await ProcessHost.verify(path.join(root, "bin"), "x64")
})

test("Memory refuses a foreign recipe even when executable and symbols hashes match", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "raya-memory-helper-recipe-"))
  try {
    const bin = path.join(root, "bin")
    await mkdir(bin)
    const current = await packaged(path.resolve("."))
    for (const file of current.names) await copyFile(file, path.join(bin, path.basename(file)))
    const file = path.join(bin, "raya-process-host.json")
    const metadata = JSON.parse(await readFile(file, "utf8"))
    await writeFile(file, JSON.stringify({ ...metadata, recipe: "0".repeat(64) }))
    await expect(packaged(root)).rejects.toThrow("Packaged helper fingerprint refused")
  } finally {
    expect(path.dirname(path.resolve(root))).toBe(path.resolve(tmpdir()))
    expect(path.basename(root).startsWith("raya-memory-helper-recipe-")).toBe(true)
    await rm(root, { recursive: true, force: true })
  }
})
