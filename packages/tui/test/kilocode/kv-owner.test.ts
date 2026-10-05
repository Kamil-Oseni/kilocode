import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readdir, rm, symlink, unlink } from "node:fs/promises"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Flock } from "@opencode-ai/core/util/flock"
import { Hash } from "@opencode-ai/core/util/hash"
import { resolveProfileRoot } from "@opencode-ai/core/kilocode/profile-maintenance"
import { createRegistry } from "@opencode-ai/core/kilocode/runtime-registry"
import { kvOwner } from "../../src/kilocode/kv-owner"

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raya-tui-kv-"))
  const state = path.join(dir, "state")
  await mkdir(state)
  const root = await resolveProfileRoot({ kind: "json", path: state })
  return {
    dir,
    state: root.path,
    file: path.join(root.path, "kv.json"),
    writers: path.join(dir, ".raya-profile-locks", `${Hash.fast(root.id)}.writers`),
    gate: path.join(dir, ".raya-profile-locks", `${Hash.fast(root.id)}.lock`),
    async [Symbol.asyncDispose]() {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test("KV cutoff joins every accepted snapshot behind the actual Flock before releasing leases", async () => {
  await using cfg = await fixture()
  const registry = createRegistry()
  const owner = kvOwner(cfg.file, registry)
  const held = await Flock.acquire(`tui-kv:${cfg.file}`, { dir: path.join(cfg.state, "locks") })
  let released: Promise<void> | undefined
  const unlock = () => (released ??= held.release())
  try {
    const snapshot = { theme: "first" }
    const first = owner.write(snapshot)
    snapshot.theme = "mutated after acceptance"
    const middle = owner.read()
    const second = owner.write({ theme: "second", draft: "café 日本語 😀" })
    expect((await readdir(cfg.writers)).length).toBe(3)
    const retired = owner.retire()
    expect(owner.retire()).toBe(retired)
    const closing = registry.drain()
    let settled = false
    void closing.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(() => owner.write({ late: true })).toThrow()
    expect(existsSync(cfg.file)).toBe(false)
    await unlock()
    await Promise.all([first, middle, second, retired, closing])
    expect(await middle).toEqual({ theme: "first" })
    expect(await Bun.file(cfg.file).json()).toEqual({ theme: "second", draft: "café 日本語 😀" })
    expect(await readdir(cfg.writers)).toEqual([])
    expect((await readdir(cfg.state)).filter((file) => file.endsWith(".tmp"))).toEqual([])
  } finally {
    await unlock()
  }
})

test("real rename failure retains sticky retirement errors and releases only after temporary cleanup", async () => {
  await using cfg = await fixture()
  await mkdir(cfg.file)
  const registry = createRegistry()
  const owner = kvOwner(cfg.file, registry)
  const first = owner.write({ theme: "first" })
  const second = owner.write({ theme: "second" })
  const results = await Promise.allSettled([first, second])
  expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"])
  expect(await readdir(cfg.writers)).toEqual([])
  expect((await readdir(cfg.state)).filter((file) => file.endsWith(".tmp"))).toEqual([])
  const retired = owner.retire()
  expect(owner.retire()).toBe(retired)
  const failure = await retired.then(
    () => undefined,
    (err: unknown) => err,
  )
  expect(failure).toBeInstanceOf(AggregateError)
  expect((failure as AggregateError).errors).toHaveLength(2)
  expect(
    await retired.then(
      () => undefined,
      (err: unknown) => err,
    ),
  ).toBe(failure)
  const closing = registry.drain()
  expect(registry.drain()).toBe(closing)
  expect(
    await closing.then(
      () => undefined,
      (err: unknown) => err,
    ),
  ).toBeInstanceOf(AggregateError)
  expect(() => owner.write({ late: true })).toThrow()
})

test("KV pins the canonical state directory when a junction is rebound", async () => {
  await using cfg = await fixture()
  const next = path.join(cfg.dir, "next")
  const alias = path.join(cfg.dir, "alias")
  await mkdir(next)
  await symlink(cfg.state, alias, process.platform === "win32" ? "junction" : "dir")
  const registry = createRegistry()
  const owner = kvOwner(path.join(alias, "kv.json"), registry)
  await unlink(alias)
  await symlink(next, alias, process.platform === "win32" ? "junction" : "dir")
  await owner.write({ pinned: true })
  await registry.drain()
  expect(await Bun.file(cfg.file).json()).toEqual({ pinned: true })
  expect(existsSync(path.join(next, "kv.json"))).toBe(false)
  expect(await readdir(cfg.writers)).toEqual([])
})

test("real independent maintenance gate drains the accepted KV write and refuses late publication", async () => {
  await using cfg = await fixture()
  const registry = createRegistry()
  const owner = kvOwner(cfg.file, registry)
  const held = await Flock.acquire(`tui-kv:${cfg.file}`, { dir: path.join(cfg.state, "locks") })
  let released: Promise<void> | undefined
  const unlock = () => (released ??= held.release())
  const task = owner.write({ accepted: true })
  const gated = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/kv-maintenance.ts"), cfg.dir], {
    cwd: path.resolve(import.meta.dir, "../.."),
    windowsHide: true,
    stdout: "pipe",
    stderr: "pipe",
    ipc(message) {
      if (message === "gated") gated.resolve()
      if (message === "entered") entered.resolve()
    },
  })
  const timeout = setTimeout(() => {
    const err = new Error("Private KV maintenance child exceeded its bound")
    gated.reject(err)
    entered.reject(err)
    child.kill()
  }, 15_000)
  try {
    await gated.promise
    expect(existsSync(cfg.gate)).toBe(true)
    expect((await readdir(cfg.writers)).length).toBe(1)
    expect(() => owner.write({ refused: true })).toThrow(/maintenance excludes/)
    expect(existsSync(cfg.file)).toBe(false)
    const retired = owner.retire()
    await unlock()
    await Promise.all([task, retired, entered.promise])
    expect(await Bun.file(cfg.file).json()).toEqual({ accepted: true })
    expect(await readdir(cfg.writers)).toEqual([])
    expect(() => kvOwner(cfg.file, createRegistry()).write({ refused: true })).toThrow(/maintenance excludes/)
    child.send("release")
    expect(await child.exited, await new Response(child.stderr).text()).toBe(0)
    const receipt = JSON.parse(await new Response(child.stdout).text())
    expect(receipt.admission.completeProfileCoverage).toBe(false)
    expect(receipt.admission.portableCaptureAuthorized).toBe(false)
    expect(existsSync(cfg.gate)).toBe(false)
    await registry.drain()
  } finally {
    clearTimeout(timeout)
    await unlock()
    if (child.exitCode === null) {
      child.kill()
      await child.exited
    }
  }
}, 20_000)

test("realized production KV provider retires on renderer cleanup and global ownership drain", async () => {
  await using cfg = await fixture()
  await mkdir(path.join(cfg.dir, "tmp"))
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/kv-provider.tsx"), cfg.dir], {
    cwd: path.resolve(import.meta.dir, "../.."),
    windowsHide: true,
    env: {
      ...process.env,
      XDG_DATA_HOME: path.join(cfg.dir, "data"),
      XDG_CONFIG_HOME: path.join(cfg.dir, "config"),
      XDG_CACHE_HOME: path.join(cfg.dir, "cache"),
      XDG_STATE_HOME: cfg.state,
      KILO_TEST_HOME: cfg.dir,
      TMP: path.join(cfg.dir, "tmp"),
      TEMP: path.join(cfg.dir, "tmp"),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timeout = setTimeout(() => child.kill(), 15_000)
  try {
    expect(await child.exited, await new Response(child.stderr).text()).toBe(0)
    expect(await Bun.file(cfg.file).json()).toEqual({ preference: "durable" })
    expect(await readdir(cfg.writers)).toEqual([])
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null) {
      child.kill()
      await child.exited
    }
  }
}, 20_000)
