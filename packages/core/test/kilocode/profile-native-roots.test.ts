import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  admitProfileOperation,
  coordinateNativeRoots,
  resolveProfileRoot,
} from "../../src/kilocode/profile-maintenance"
import { profileSqlite } from "../../src/kilocode/profile-sqlite"
import { Flock } from "../../src/util/flock"
import { Hash } from "../../src/util/hash"

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raya-profile-all-roots-"))
  for (const name of ["first", "second"]) await mkdir(path.join(dir, name))
  return {
    dir,
    async [Symbol.asyncDispose]() {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

async function wait(check: () => boolean | Promise<boolean>) {
  const stop = performance.now() + 5_000
  while (!(await check())) {
    if (performance.now() >= stop) throw new Error("All-root fixture state deadline elapsed")
    await Bun.sleep(10)
  }
}

function child(dir: string, mode: string) {
  const proc = Bun.spawn([process.execPath, path.join(import.meta.dir, "profile-native-roots-worker.ts"), dir, mode], {
    windowsHide: true,
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = new Response(proc.stdout).text()
  const stderr = new Response(proc.stderr).text()
  return {
    proc,
    stdout,
    stderr,
    async [Symbol.asyncDispose]() {
      if (proc.exitCode === null) proc.kill()
      await proc.exited
    },
  }
}

test("all-root maintenance refuses each independent idle native root until every handle is closed", async () => {
  await using tmp = await fixture()
  const roots = ["first", "second"].map((name) => ({
    kind: "sqlite" as const,
    path: path.join(tmp.dir, name, "owned.db"),
  }))
  const owners = roots.map((root) => profileSqlite(root.path, () => new Database(root.path)))
  let called = false
  const body = async () => {
    called = true
    for (const root of roots) {
      expect(() => profileSqlite(root.path, () => new Database(root.path))).toThrow("maintenance excludes")
      expect(() => admitProfileOperation(root)).toThrow("maintenance excludes")
    }
    return "settled"
  }
  try {
    await assert.rejects(coordinateNativeRoots(roots, body), /remain live/)
    expect(called).toBe(false)
    owners[0].close()
    await assert.rejects(coordinateNativeRoots(roots, body), /remain live/)
    expect(called).toBe(false)
    owners[1].close()
    const result = await coordinateNativeRoots(roots, body)
    expect(result).toMatchObject({
      value: "settled",
      admission: {
        nativeOwners: 0,
        operations: 0,
        participantOnly: true,
        cooperativeOnly: true,
        completeProfileCoverage: false,
        portableCaptureAuthorized: false,
        portable: false,
      },
    })
    expect(result.admission.roots).toHaveLength(2)
  } finally {
    for (const owner of owners) owner.close()
  }
})

test("canonical aliases deduplicate actual roots with deterministic order and scope", async () => {
  await using tmp = await fixture()
  const alias = path.join(tmp.dir, "alias")
  await symlink(path.join(tmp.dir, "first"), alias, process.platform === "win32" ? "junction" : "dir")
  const roots = [
    { kind: "sqlite" as const, path: path.join(tmp.dir, "first", "future.db") },
    { kind: "json" as const, path: path.join(tmp.dir, "second") },
  ]
  const first = await coordinateNativeRoots(roots, async () => "first")
  const second = await coordinateNativeRoots(
    [roots[1], { kind: "sqlite", path: path.join(alias, "future.db") }, roots[0], roots[1]],
    async () => "second",
  )
  expect(second.admission.scope).toBe(first.admission.scope)
  expect(second.admission.roots).toEqual(first.admission.roots)
  expect(second.admission.roots).toHaveLength(2)
  expect(await Bun.file(roots[0].path).exists()).toBe(false)
})

test("independent native roots prevent a receipt until their actual process closes every database", async () => {
  await using tmp = await fixture()
  await using worker = child(tmp.dir, "native")
  await wait(() => Bun.file(path.join(tmp.dir, "ready")).exists())
  const roots = ["first", "second"].map((name) => ({
    kind: "sqlite" as const,
    path: path.join(tmp.dir, name, "owned.db"),
  }))
  let called = false
  await assert.rejects(
    coordinateNativeRoots(roots, async () => {
      called = true
    }),
    /remain live/,
  )
  expect(called).toBe(false)
  await writeFile(path.join(tmp.dir, "release"), "release")
  expect(await worker.proc.exited, await worker.stderr).toBe(0)
  expect(await worker.stdout).toContain('"closed":true')
  const result = await coordinateNativeRoots(roots, async () => {
    for (const root of roots) {
      using db = new Database(root.path, { readonly: true })
      expect(db.query("SELECT value FROM fixture").all()).toEqual([{ value: "durable" }])
    }
    return "verified"
  })
  expect(result.value).toBe("verified")
})

test("maintenance releases its waiting gates so an accepted parent can finish a real subprocess child", async () => {
  await using tmp = await fixture()
  const roots = ["first", "second"].map((name) => ({ kind: "json" as const, path: path.join(tmp.dir, name) }))
  await using accepted = child(tmp.dir, "nested")
  await wait(() => Bun.file(path.join(tmp.dir, "ready")).exists())
  const resolved = await Promise.all(roots.map(resolveProfileRoot))
  const gates = resolved.map((root) =>
    path.join(path.dirname(root.path), ".raya-profile-locks", `${Hash.fast(root.id)}.lock`),
  )
  const blocker = await Flock.acquire(resolved[1].id, { dir: path.dirname(gates[1]), timeoutMs: 5000 })
  let entered = 0
  const pending = coordinateNativeRoots(roots.reverse(), async () => {
    entered += 1
    for (const [index, name] of ["first", "second"].entries()) {
      expect(await Bun.file(path.join(tmp.dir, name, "value.json")).json()).toEqual({ value: index })
      expect(() => admitProfileOperation({ kind: "json", path: path.join(tmp.dir, name) })).toThrow(
        "maintenance excludes",
      )
    }
    await using late = child(tmp.dir, "late")
    expect(await late.proc.exited, await late.stderr).toBe(0)
    expect(await late.stdout).toContain('"excluded":true')
    return "captured"
  })
  await wait(() => existsSync(gates[0]))
  await writeFile(path.join(tmp.dir, "child"), "launch-accepted-child")
  await wait(() => Bun.file(path.join(tmp.dir, "waiting")).exists())
  expect(entered).toBe(0)
  await blocker.release()
  expect(await accepted.proc.exited, await accepted.stderr).toBe(0)
  expect(await accepted.stdout).toContain('"nested":true')
  expect((await pending).value).toBe("captured")
  expect(entered).toBe(1)
  expect(gates.some(existsSync)).toBe(false)
})

test("invalid roots and body failure never return a maintenance receipt", async () => {
  await using tmp = await fixture()
  let called = false
  const body = async () => {
    called = true
  }
  await assert.rejects(coordinateNativeRoots([], body), /empty/)
  const invalid = { kind: "json" as const, path: tmp.dir }
  Object.defineProperty(invalid, "kind", { value: "unknown" })
  await assert.rejects(coordinateNativeRoots([invalid], body), /Unknown/)
  await assert.rejects(coordinateNativeRoots([{ kind: "json", path: "relative" }], body), /absolute/)
  expect(called).toBe(false)
  const root = { kind: "json" as const, path: tmp.dir }
  const primary = new Error("body failed")
  const result = await coordinateNativeRoots([root], async () => {
    throw primary
  }).then(
    () => undefined,
    (err: unknown) => err,
  )
  expect(result).toBe(primary)
  const lease = admitProfileOperation(root)
  lease.release()
})

test("selected roots are snapshotted before awaits and receipt metadata cannot be mutated", async () => {
  await using tmp = await fixture()
  const selected: { kind: "sqlite" | "json"; path: string } = {
    kind: "sqlite",
    path: path.join(tmp.dir, "first", "future.db"),
  }
  const original = selected.path
  const pending = coordinateNativeRoots([selected], async () => {
    selected.kind = "json"
    selected.path = path.join(tmp.dir, "second")
  })
  selected.kind = "json"
  selected.path = path.join(tmp.dir, "second")
  const result = await pending
  expect(result.admission.roots).toEqual([{ kind: "sqlite", path: original }])
  expect(Object.isFrozen(result.admission.roots)).toBe(true)
  expect(Object.isFrozen(result.admission.roots[0])).toBe(true)
  expect(Reflect.set(result.admission.roots[0], "kind", "json")).toBe(false)
  expect(result.admission.roots[0].kind).toBe("sqlite")
})
