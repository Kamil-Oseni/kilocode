import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Schema } from "effect"
import { createInventory } from "../../src/kilocode/profile-roots"

test("metadata inventory deduplicates admitted roots and exposes frozen independent snapshots", () => {
  const inventory = createInventory()
  const file = path.join(os.tmpdir(), "inventory", "database.db")
  const json = path.join(os.tmpdir(), "inventory", "json")
  const source = { kind: "sqlite" as const, path: file }
  inventory.register(source)
  source.path = path.join(os.tmpdir(), "untracked.db")
  inventory.register({ kind: "sqlite", path: file })
  if (process.platform === "win32") inventory.register({ kind: "sqlite", path: file.toUpperCase() })
  const before = inventory.snapshot()
  expect(before).toEqual([{ kind: "sqlite", path: file }])
  expect(Reflect.set(before[0], "path", "changed")).toBe(false)
  expect(Reflect.set(before, "0", { kind: "json", path: json })).toBe(false)
  inventory.register({ kind: "json", path: json })
  const after = inventory.snapshot()
  expect(before).toEqual([{ kind: "sqlite", path: file }])
  expect(after).toHaveLength(2)
  expect(after).not.toBe(inventory.snapshot())
  expect(after[0]).not.toBe(inventory.snapshot()[0])
  expect(() => inventory.register({ kind: "json", path: "relative" })).toThrow("absolute canonical root")
  expect(() => inventory.register({ kind: "sqlite", path: ":memory:" })).toThrow("absolute canonical root")
})

test("fresh process retains actual graph, external export and JSON roots through closure and generation changes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "raya-profile-inventory-"))
  const child = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "fixture/profile-roots.ts"), JSON.stringify({ dir })],
    { stdout: "pipe", stderr: "pipe", windowsHide: true },
  )
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  const timer = setTimeout(() => child.kill(), 15_000)
  try {
    expect(await child.exited, await stderr).toBe(0)
    const root = Schema.Struct({ kind: Schema.Literals(["sqlite", "json"]), path: Schema.String })
    const result = Schema.decodeUnknownSync(
      Schema.Struct({
        primary: Schema.String,
        external: Schema.String,
        json: Schema.String,
        unused: Schema.String,
        next: Schema.String,
        failed: Schema.String,
        denied: Schema.String,
        before: Schema.Array(root),
        closed: Schema.Array(root),
        final: Schema.Array(root),
        unusedExists: Schema.Boolean,
        portableCaptureAuthorized: Schema.Boolean,
      }),
    )(JSON.parse(await stdout))
    expect(result.before).toHaveLength(3)
    expect(result.before).toContainEqual({ kind: "sqlite", path: result.primary })
    expect(result.before).toContainEqual({ kind: "sqlite", path: result.external })
    expect(result.before).toContainEqual({ kind: "json", path: result.json })
    expect(result.closed).toEqual(result.before)
    expect(result.final).toHaveLength(5)
    expect(result.final).toContainEqual({ kind: "sqlite", path: result.next })
    expect(result.final).toContainEqual({ kind: "sqlite", path: result.failed })
    expect(result.final.some((root) => root.path === result.unused || root.path === result.denied)).toBe(false)
    expect(result.unusedExists).toBe(false)
    expect(result.portableCaptureAuthorized).toBe(false)
    await fs.rm(dir, { recursive: true, force: true })
  } catch (err) {
    await fs.writeFile(path.join(dir, "failure.txt"), String(err))
    console.error(`Retained profile inventory test: ${dir}`)
    throw err
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill()
    await child.exited
    if (await Bun.file(dir).exists())
      await fs.writeFile(
        path.join(dir, "child.json"),
        JSON.stringify({ pid: child.pid, code: child.exitCode, stdout: await stdout, stderr: await stderr }),
      )
  }
}, 20_000)
