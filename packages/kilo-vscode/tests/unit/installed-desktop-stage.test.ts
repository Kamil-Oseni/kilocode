import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Flock } from "@opencode-ai/core/util/flock"
import { PackageVault } from "../../src/services/package-vault"
import { measure } from "../../src/commands/installed-desktop-stage"

test("reports actual diagnostic reads without retaining private errors", async () => {
  const root = await mkdtemp(join(import.meta.dir, ".desktop-stage-"))
  try {
    const file = join(root, "diagnostic.json")
    await writeFile(file, "ready")
    const ready = await measure((signal) => readFile(file, { encoding: "utf8", signal }), 1000)
    expect(ready.status).toBe("ready")
    expect(ready.value).toBe("ready")
    expect(Number.isFinite(ready.elapsedMs)).toBe(true)
    expect(ready.elapsedMs).toBeGreaterThanOrEqual(0)
    const vault = new PackageVault(root)
    expect((await measure((signal) => vault.current(signal), 1000)).status).toBe("missing")
    await writeFile(join(root, "packages.json"), "private malformed package detail")
    const failed = await measure((signal) => vault.current(signal), 1000)
    expect(failed.status).toBe("failed")
    expect(failed.value).toBeUndefined()
    expect(JSON.stringify(failed)).not.toContain("private")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("deadline cancels a real vault lock wait without releasing its owner or publishing late results", async () => {
  const root = await mkdtemp(join(import.meta.dir, ".desktop-stage-"))
  const directory = join(root, ".locks")
  await mkdir(directory)
  const owner = await Flock.acquire("raya-package-vault", { dir: directory })
  const state = { released: false }
  const vault = new PackageVault(root)
  let signal: AbortSignal | undefined
  try {
    const report = await measure((value) => {
      signal = value
      return vault.current(value)
    }, 20)
    expect(report.status).toBe("timeout")
    expect(signal?.aborted).toBe(true)
    expect(report.value).toBeUndefined()
    expect(Number.isFinite(report.elapsedMs)).toBe(true)
    await expect(
      Flock.acquire("raya-package-vault", { dir: directory, signal: AbortSignal.timeout(30) }),
    ).rejects.toThrow()
    await owner.release()
    state.released = true
    expect(await vault.current()).toBeUndefined()
    expect(report.status).toBe("timeout")
    expect(report.value).toBeUndefined()
  } finally {
    if (!state.released) await owner.release()
    await rm(root, { recursive: true, force: true })
  }
})

test("a late callback cannot change or disclose a timed-out result", async () => {
  const late = Promise.withResolvers<string>()
  const report = await measure(() => late.promise, 10)
  late.resolve("private late value")
  await late.promise
  await Promise.resolve()
  expect(report.status).toBe("timeout")
  expect(report.value).toBeUndefined()
  expect(JSON.stringify(report)).not.toContain("private")
})
