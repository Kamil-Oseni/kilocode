import { afterAll, beforeAll, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ProcessHost } from "../../script/kilocode/process-host"

const native = process.platform === "win32" && process.arch === "x64"
const root = await mkdtemp(path.join(os.tmpdir(), "raya-process-package-"))
const source = path.join(root, "source")
const other = path.join(root, "other")
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex")
beforeAll(async () => {
  if (!native) return
  await ProcessHost.build(source, "x64")
  await ProcessHost.build(other, "x64")
}, 180000)
afterAll(() => rm(root, { recursive: true, force: true }), 90000)

async function candidate(name: string) {
  const directory = path.join(root, name)
  await cp(source, directory, { recursive: true })
  return directory
}
async function identity(directory: string, field: "exe" | "pdb", data: Buffer) {
  const file = path.join(directory, ProcessHost.files[2])
  const value: Record<string, unknown> = JSON.parse(await readFile(file, "utf8"))
  value[field] = sha(data)
  await writeFile(file, JSON.stringify(value))
}
async function rejected(body: () => Promise<void>, text: string) {
  const error = await body().then(
    () => undefined,
    (err: unknown) => err,
  )
  expect(error).toBeInstanceOf(Error)
  expect(error instanceof Error && error.message).toContain(text)
}

test.skipIf(!native)(
  "stages exact native executable and matching symbols beside a standalone CLI",
  async () => {
    const target = path.join(root, "standalone-bin")
    await ProcessHost.stage(source, target, "x64")
    await ProcessHost.verify(target, "x64")
    for (const file of [...ProcessHost.files, "raya-process-mode.json"])
      expect(await readFile(path.join(target, file))).toEqual(await readFile(path.join(source, file)))
  },
  90000,
)

test.skipIf(!native)(
  "refuses stale native identity and clears a previously staged candidate",
  async () => {
    const directory = await candidate("stale")
    const target = path.join(root, "failed-staging")
    await ProcessHost.stage(source, target, "x64")
    const file = path.join(directory, ProcessHost.files[2])
    const value: Record<string, unknown> = JSON.parse(await readFile(file, "utf8"))
    value.recipe = "0".repeat(64)
    await writeFile(file, JSON.stringify(value))
    await rejected(() => ProcessHost.stage(directory, target, "x64"), "stale")
    for (const name of [...ProcessHost.files, "raya-process-mode.json"])
      expect(await Bun.file(path.join(target, name)).exists()).toBe(false)
  },
  90000,
)

test.skipIf(!native)(
  "refuses missing, changed architecture and mismatched native symbols",
  async () => {
    const missing = await candidate("missing")
    await rm(path.join(missing, ProcessHost.files[1]))
    await rejected(() => ProcessHost.verify(missing, "x64"), "ENOENT")
    const architecture = await candidate("architecture")
    const file = path.join(architecture, ProcessHost.files[0])
    const data = await readFile(file)
    data.writeUInt16LE(0xaa64, data.readUInt32LE(60) + 4)
    await writeFile(file, data)
    await identity(architecture, "exe", data)
    await rejected(() => ProcessHost.verify(architecture, "x64"), "architecture")
    const mismatch = await candidate("mismatch")
    const pdb = await readFile(path.join(other, ProcessHost.files[1]))
    await writeFile(path.join(mismatch, ProcessHost.files[1]), pdb)
    await identity(mismatch, "pdb", pdb)
    await rejected(() => ProcessHost.verify(mismatch, "x64"), "do not match")
    await rejected(() => ProcessHost.verify(source, "arm64"), "Windows x64")
  },
  90000,
)

test("requires explicit legacy declaration and discards prior native candidate files", async () => {
  const directory = path.join(root, "legacy")
  await mkdir(directory, { recursive: true })
  for (const file of ProcessHost.files) await writeFile(path.join(directory, file), "prior native candidate")
  await ProcessHost.prepare(directory, "arm64")
  expect(await Bun.file(path.join(directory, "raya-process-mode.json")).json()).toEqual({ version: 1, mode: "legacy" })
  for (const file of ProcessHost.files) expect(await Bun.file(path.join(directory, file)).exists()).toBe(false)
  await ProcessHost.verify(directory, "arm64")
  const target = path.join(root, "legacy-bin")
  await ProcessHost.stage(directory, target, "arm64")
  expect(await Bun.file(path.join(target, "raya-process-mode.json")).json()).toEqual({ version: 1, mode: "legacy" })
  await writeFile(path.join(target, "raya-process-mode.json"), JSON.stringify({ version: 1, mode: "automatic" }))
  await rejected(() => ProcessHost.verify(target, "x64"), "declaration")
}, 90000)
