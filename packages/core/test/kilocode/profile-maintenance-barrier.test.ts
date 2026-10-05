import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  acquireProfileRoot,
  admitProfileOperation,
  coordinateNativeRoots,
  resolveProfileRoot,
} from "../../src/kilocode/profile-maintenance"
import { Flock } from "../../src/util/flock"
import { Hash } from "../../src/util/hash"

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raya-maintenance-barrier-"))
  const roots = await Promise.all(
    ["first", "second"].map(async (name) => {
      const file = path.join(dir, name)
      await mkdir(file)
      return resolveProfileRoot({ kind: "json", path: file })
    }),
  )
  const keys = roots.map((root) => path.join(path.dirname(root.path), ".raya-profile-locks", Hash.fast(root.id)))
  return {
    roots,
    keys,
    async [Symbol.asyncDispose]() {
      await rm(dir, { recursive: true, force: true })
    },
  }
}
async function wait(body: () => boolean | Promise<boolean>) {
  const stop = performance.now() + 2000
  while (!(await body())) {
    if (performance.now() >= stop) throw new Error("Actual barrier fixture state missing")
    await Bun.sleep(5)
  }
}

test("late real admission during outside-gate draining is joined before the stable body", async () => {
  await using cfg = await fixture()
  const outer = await acquireProfileRoot(cfg.roots[1])
  const blocker = await Flock.acquire(cfg.roots[1].id, { dir: path.dirname(cfg.keys[1]) })
  let calls = 0
  const pending = coordinateNativeRoots(cfg.roots, async () => {
    calls += 1
    expect(await Bun.file(path.join(cfg.roots[0].path, "late.json")).text()).toBe("actual late body")
    for (const root of cfg.roots) expect(() => admitProfileOperation(root)).toThrow("maintenance excludes")
  })
  await wait(() => existsSync(cfg.keys[0] + ".lock"))
  await blocker.release()
  await wait(() => !cfg.keys.some((key) => existsSync(key + ".lock")))
  const late = await acquireProfileRoot(cfg.roots[0])
  await outer.release()
  expect(calls).toBe(0)
  await writeFile(path.join(cfg.roots[0].path, "late.json"), "actual late body")
  await late.release()
  await pending
  expect(calls).toBe(1)
})

test("outside-gate drain keeps original abort identity and malformed bytes through deadline refusal", async () => {
  await using cfg = await fixture()
  const outer = await acquireProfileRoot(cfg.roots[0])
  const foreign = path.join(cfg.keys[0] + ".writers", "foreign.json")
  await writeFile(foreign, "unsupported original bytes")
  const blocker = await Flock.acquire(cfg.roots[0].id, { dir: path.dirname(cfg.keys[0]) })
  const controller = new AbortController()
  const reason = new Error("Actual original cancellation")
  let calls = 0
  const pending = coordinateNativeRoots(
    [cfg.roots[0]],
    async () => {
      calls += 1
    },
    { signal: controller.signal, timeoutMs: 1000 },
  ).then(
    () => undefined,
    (err: unknown) => err,
  )
  await blocker.release()
  await wait(() => !existsSync(cfg.keys[0] + ".lock"))
  controller.abort(reason)
  expect(await pending).toBe(reason)
  expect(calls).toBe(0)
  expect(await readFile(foreign, "utf8")).toBe("unsupported original bytes")
  await outer.release()
  await assert.rejects(
    coordinateNativeRoots(
      [cfg.roots[0]],
      async () => {
        calls += 1
      },
      { timeoutMs: 80 },
    ),
    /timed out draining/,
  )
  expect(calls).toBe(0)
  expect(await readFile(foreign, "utf8")).toBe("unsupported original bytes")
  expect(existsSync(cfg.keys[0] + ".lock")).toBe(false)
})

test("stable body cancellation joins real completion before releasing all gates", async () => {
  await using cfg = await fixture()
  const controller = new AbortController()
  const reason = new Error("Actual stable-body cancellation")
  let ready!: () => void
  let finish!: () => void
  const entered = new Promise<void>((resolve) => {
    ready = resolve
  })
  const done = new Promise<void>((resolve) => {
    finish = resolve
  })
  let calls = 0
  const pending = coordinateNativeRoots(
    cfg.roots,
    async () => {
      calls += 1
      ready()
      await done
    },
    { signal: controller.signal },
  ).then(
    () => undefined,
    (err: unknown) => err,
  )
  await entered
  controller.abort(reason)
  for (const root of cfg.roots) expect(() => admitProfileOperation(root)).toThrow("maintenance excludes")
  finish()
  expect(await pending).toBe(reason)
  expect(calls).toBe(1)
  for (const root of cfg.roots) {
    const lease = admitProfileOperation(root)
    lease.release()
  }
})

test("actual gate release failure preserves the original body failure without replay", async () => {
  await using cfg = await fixture()
  const meta = path.join(cfg.keys[0] + ".lock", "meta.json")
  const primary = new Error("Actual body failure")
  let calls = 0
  const error = await coordinateNativeRoots([cfg.roots[0]], async () => {
    calls += 1
    const original = JSON.parse(await readFile(meta, "utf8"))
    await writeFile(meta, JSON.stringify({ ...original, token: "different-actual-token" }))
    throw primary
  }).then(
    () => undefined,
    (err: unknown) => err,
  )
  expect(error).toBeInstanceOf(SuppressedError)
  if (!(error instanceof SuppressedError)) throw new Error("Original body/release pair missing")
  expect(error.suppressed).toBe(primary)
  expect(error.error.message).toContain("lock token mismatch")
  expect(calls).toBe(1)
  expect(existsSync(meta)).toBe(true)
})
