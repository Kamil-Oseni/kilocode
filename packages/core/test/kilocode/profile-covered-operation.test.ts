import { expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { lstat, mkdtemp, mkdir, readdir, rename, rm, rmdir, symlink, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  acquireCoveredProfileRoot,
  acquireProfileRoot,
  coordinateNativeRoots,
  registerProfileFile,
  resolveProfileRoot,
} from "../../src/kilocode/profile-maintenance"
import { ProfileRoots } from "../../src/kilocode/profile-roots"
import { Hash } from "../../src/util/hash"

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raya-covered-"))
  const root = { kind: "json" as const, path: path.join(dir, "memory") }
  await mkdir(root.path)
  return {
    dir,
    root,
    async [Symbol.asyncDispose]() {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

async function wait(file: string) {
  const stop = performance.now() + 5_000
  while (!(await Bun.file(file).exists())) {
    if (performance.now() > stop) throw new Error("Actual subprocess did not reach its boundary")
    await Bun.sleep(5)
  }
}

async function refuses(pending: Promise<unknown>, text: string) {
  await rejects(pending, (err: unknown) => err instanceof Error && err.message.includes(text))
}

test("real subprocess mkdir-to-publication race exposes only a cleaned-up link ENOENT and never loses a valid marker", async () => {
  await using tmp = await fixture()
  const outer = await acquireProfileRoot(tmp.root)
  const root = { kind: "json" as const, path: path.join(tmp.root.path, "value.json") }
  const child = await acquireCoveredProfileRoot(root, outer)
  await child.release()
  const worker = Bun.spawn(
    [
      process.execPath,
      path.join(import.meta.dir, "profile-covered-worker.ts"),
      JSON.stringify({ root: root.path, dir: tmp.dir }),
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  try {
    await wait(path.join(tmp.dir, "ready"))
    await outer.release()
    await writeFile(path.join(tmp.dir, "publish"), "continue genuine publisher")
    await wait(path.join(tmp.dir, "admitted"))
    const failure = await Bun.file(path.join(tmp.dir, "failure.json")).json()
    expect(failure.code).toBe("ENOENT")
    expect(failure.syscall).toBe("link")
    expect(path.dirname(failure.dest)).toEndWith(".writers")
    expect(await Bun.file(failure.path).exists()).toBe(false)
    const resolved = await resolveProfileRoot(root)
    const dir = path.join(path.dirname(root.path), ".raya-profile-locks", Hash.fast(resolved.id) + ".writers")
    const names = await readdir(dir)
    expect(names).toHaveLength(1)
    const marker = path.join(dir, names[0])
    const before = await Bun.file(marker).text()
    await refuses(
      coordinateNativeRoots([root], async () => "unexpected", { timeoutMs: 60 }),
      "draining",
    )
    expect(await Bun.file(marker).text()).toBe(before)
    await writeFile(path.join(tmp.dir, "release"), "settle actual admitted writer")
    expect(await worker.exited).toBe(0)
    expect(await Bun.file(marker).exists()).toBe(false)
  } finally {
    if (worker.exitCode === null) worker.kill()
    await worker.exited
  }
})

test("empty writer cleanup leaves an actual live peer native owner and its exact bytes untouched", async () => {
  await using tmp = await fixture()
  const outer = await acquireProfileRoot(tmp.root)
  const root = { kind: "json" as const, path: path.join(tmp.root.path, "live.json") }
  await writeFile(root.path, "live peer file")
  const peer = registerProfileFile(root)
  try {
    const child = await acquireCoveredProfileRoot(root, outer)
    await writeFile(root.path, "actual admitted mutation")
    await child.release()
    const resolved = await resolveProfileRoot(root)
    const prefix = path.join(path.dirname(root.path), ".raya-profile-locks", Hash.fast(resolved.id))
    const names = await readdir(prefix + ".owners")
    expect(names).toHaveLength(1)
    const marker = path.join(prefix + ".owners", names[0])
    const before = await Bun.file(marker).text()
    await outer.release()
    expect(await Bun.file(marker).text()).toBe(before)
    expect(await readdir(prefix + ".writers")).toEqual([])
    expect(await Bun.file(root.path).text()).toBe("actual admitted mutation")
  } finally {
    peer.release()
  }
})

test("cleanup refuses a different empty directory generation and preserves it for explicit repair", async () => {
  await using tmp = await fixture()
  const outer = await acquireProfileRoot(tmp.root)
  const root = { kind: "json" as const, path: path.join(tmp.root.path, "value.json") }
  const child = await acquireCoveredProfileRoot(root, outer)
  await child.release()
  const resolved = await resolveProfileRoot(root)
  const dir = path.join(path.dirname(root.path), ".raya-profile-locks", Hash.fast(resolved.id) + ".writers")
  const original = dir + ".original"
  await rename(dir, original)
  await mkdir(dir)
  await refuses(outer.release(), "admission identity changed")
  expect(await readdir(dir)).toEqual([])
  expect(await readdir(original)).toEqual([])
  await rmdir(dir)
  await rename(original, dir)
  await outer.release()
  expect(await Bun.file(dir).exists()).toBe(false)
})

test("lawful concurrent parent cleanup never invalidates another accepted writer directory generation", async () => {
  await using tmp = await fixture()
  const root = { kind: "json" as const, path: path.join(tmp.root.path, "shared.json") }
  const one = await acquireProfileRoot(tmp.root)
  const two = await acquireProfileRoot(tmp.root)
  const first = await acquireCoveredProfileRoot(root, one)
  const second = await acquireCoveredProfileRoot(root, two)
  await writeFile(root.path, "first genuine generation")
  await first.release()
  await second.release()
  await one.release()
  const three = await acquireProfileRoot(tmp.root)
  const third = await acquireCoveredProfileRoot(root, three)
  await writeFile(root.path, "later genuine generation")
  await third.release()
  await two.release()
  await three.release()
  expect(await Bun.file(root.path).text()).toBe("later genuine generation")
})

test("cross-process references retain the accepted generation until every enclosing parent retires", async () => {
  await using tmp = await fixture()
  const root = { kind: "json" as const, path: path.join(tmp.root.path, "shared.json") }
  const outer = await acquireProfileRoot(tmp.root)
  const first = await acquireCoveredProfileRoot(root, outer)
  await first.release()
  const worker = Bun.spawn(
    [
      process.execPath,
      path.join(import.meta.dir, "profile-covered-worker.ts"),
      JSON.stringify({ root: root.path, dir: tmp.dir, mode: "covered" }),
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  try {
    await wait(path.join(tmp.dir, "ready"))
    await writeFile(path.join(tmp.dir, "child-release"), "retire child only")
    await wait(path.join(tmp.dir, "released"))
    const resolved = await resolveProfileRoot(root)
    const dir = path.join(path.dirname(root.path), ".raya-profile-locks")
    const file = path.join(dir, Hash.fast(resolved.id) + ".writers")
    const before = await Bun.file(
      path.join(dir, "covered.references", (await readdir(path.join(dir, "covered.references")))[0]),
    ).text()
    await outer.release()
    expect(await readdir(file)).toEqual([])
    expect(await readdir(path.join(dir, "covered.references"))).toHaveLength(1)
    const later = await acquireProfileRoot(tmp.root)
    const third = await acquireCoveredProfileRoot(root, later)
    await third.release()
    await writeFile(path.join(tmp.dir, "parent-release"), "settle cross-process reference")
    expect(await worker.exited).toBe(0)
    expect(before).toContain("raya.profile-covered-reference")
    await later.release()
    expect(await Bun.file(file).exists()).toBe(false)
    expect(await readdir(path.join(dir, "covered.references"))).toEqual([])
  } finally {
    if (worker.exitCode === null) worker.kill()
    await worker.exited
  }
})

test("covered intake waits for an exact file gate and parent retirement joins accepted work", async () => {
  await using tmp = await fixture()
  const outer = await acquireProfileRoot(tmp.root)
  const root = { kind: "json" as const, path: path.join(tmp.root.path, "session.json") }
  const ready = Promise.withResolvers<void>()
  const exit = Promise.withResolvers<void>()
  const gate = coordinateNativeRoots([root], async () => {
    ready.resolve()
    await exit.promise
  })
  await ready.promise
  let admitted = false
  const pending = acquireCoveredProfileRoot(root, outer).then((lease) => {
    admitted = true
    return lease
  })
  const container = path.join(path.dirname(root.path), ".raya-profile-locks", "covered.references")
  const stop = performance.now() + 1_000
  while (
    !(
      await readdir(container).catch((err: unknown) => {
        if (!err || typeof err !== "object" || !("code" in err) || err.code !== "ENOENT") throw err
        return []
      })
    ).length
  ) {
    if (performance.now() >= stop) throw new Error("Accepted intake did not publish its defensive reference")
    await Bun.sleep(5)
  }
  expect(await readdir(container)).toHaveLength(1)
  let retired = false
  const closing = outer.release().then(() => {
    retired = true
  })
  await refuses(acquireCoveredProfileRoot(root, outer), "expired")
  await Bun.sleep(60)
  expect(admitted).toBe(false)
  expect(retired).toBe(false)
  exit.resolve()
  await gate
  const lease = await pending
  expect(admitted).toBe(true)
  expect(retired).toBe(false)
  await writeFile(root.path, "actual admitted body")
  await lease.release()
  await closing
  expect(retired).toBe(true)
  await refuses(acquireCoveredProfileRoot(root, outer), "expired")
})

test("unknown defensive references retain residue and exact own-reference tamper refuses joined cleanup", async () => {
  await using tmp = await fixture()
  const root = { kind: "json" as const, path: path.join(tmp.root.path, "reference.json") }
  const outer = await acquireProfileRoot(tmp.root)
  const child = await acquireCoveredProfileRoot(root, outer)
  await child.release()
  const dir = path.join(path.dirname(root.path), ".raya-profile-locks", "covered.references")
  const own = path.join(dir, (await readdir(dir))[0])
  const before = await Bun.file(own).text()
  await writeFile(own, "changed ownership")
  await refuses(outer.release(), "reference ownership changed")
  expect(await Bun.file(own).text()).toBe("changed ownership")
  await writeFile(own, before)
  const foreign = path.join(dir, "unknown.reference")
  await writeFile(foreign, "unclassified external metadata")
  await outer.release()
  expect(await Bun.file(own).exists()).toBe(false)
  expect(await Bun.file(foreign).text()).toBe("unclassified external metadata")
  const resolved = await resolveProfileRoot(root)
  expect(await readdir(path.join(path.dirname(dir), Hash.fast(resolved.id) + ".writers"))).toEqual([])
})

test("oversized Unicode namespace references refuse before publication and settle their actual enclosing lease", async () => {
  await using tmp = await fixture()
  const root = {
    kind: "json" as const,
    path: path.join(tmp.root.path, ...Array.from({ length: 24 }, () => "界".repeat(32))),
  }
  await mkdir(root.path, { recursive: true })
  expect((await lstat(root.path)).isDirectory()).toBe(true)
  const outer = await acquireProfileRoot(root)
  const target = { kind: "json" as const, path: path.join(root.path, "value.json") }
  await refuses(acquireCoveredProfileRoot(target, outer), "publication exceeds its byte bound")
  const container = path.join(root.path, ".raya-profile-locks", "covered.references")
  expect(await readdir(container)).toEqual([])
  const selected = await resolveProfileRoot(target)
  const marker = await lstat(path.join(root.path, ".raya-profile-locks", Hash.fast(selected.id) + ".writers")).catch(
    (err: unknown) => {
      if (!err || typeof err !== "object" || !("code" in err) || err.code !== "ENOENT") throw err
      return undefined
    },
  )
  expect(marker).toBeUndefined()
  expect(await Bun.file(target.path).exists()).toBe(false)
  await outer.release()
  const namespace = await resolveProfileRoot(root)
  expect(
    await readdir(path.join(path.dirname(root.path), ".raya-profile-locks", Hash.fast(namespace.id) + ".writers")),
  ).toEqual([])
  await refuses(acquireCoveredProfileRoot(target, outer), "expired")
})

test("namespace maintenance waits for real child completion and exact markers retain independent exclusion", async () => {
  await using tmp = await fixture()
  const outer = await acquireProfileRoot(tmp.root)
  const root = { kind: "json" as const, path: path.join(tmp.root.path, "session.json") }
  const child = await acquireCoveredProfileRoot(root, outer)
  expect(() => outer.finish()).toThrow("remain active")
  let entered = false
  const maintenance = coordinateNativeRoots([tmp.root], async () => {
    entered = true
  })
  await refuses(
    coordinateNativeRoots([root], async () => "unexpected", { timeoutMs: 60 }),
    "draining",
  )
  const closing = outer.release()
  await Bun.sleep(40)
  expect(entered).toBe(false)
  await writeFile(root.path, "completed")
  await child.release()
  await closing
  await maintenance
  expect(entered).toBe(true)
})

test("covered authority refuses forged, serialized, escaped, file and replaced namespaces", async () => {
  await using tmp = await fixture()
  const outer = await acquireProfileRoot(tmp.root)
  const root = { kind: "json" as const, path: path.join(tmp.root.path, "session.json") }
  for (const lease of [{ ...outer }, JSON.parse(JSON.stringify(outer)), {}])
    await refuses(acquireCoveredProfileRoot(root, lease), "expired")
  await refuses(acquireCoveredProfileRoot({ kind: "json", path: path.join(tmp.dir, "outside") }, outer), "escapes")
  await refuses(acquireCoveredProfileRoot(tmp.root, outer), "escapes")
  await writeFile(root.path, "file")
  const file = await acquireProfileRoot(root)
  await refuses(acquireCoveredProfileRoot({ kind: "json", path: path.join(root.path, "child") }, file), "expired")
  await file.release()
  await rename(tmp.root.path, path.join(tmp.dir, "original"))
  await mkdir(tmp.root.path)
  await refuses(acquireCoveredProfileRoot(root, outer), "identity changed")
  await outer.release()
})

test("missing namespaces bind their genuine ancestor then pin the created directory and reject alias escape", async () => {
  await using tmp = await fixture()
  const root = { kind: "json" as const, path: path.join(tmp.root.path, "new", "namespace") }
  const outer = await acquireProfileRoot(root)
  await mkdir(root.path, { recursive: true })
  const target = { kind: "json" as const, path: path.join(root.path, "value.json") }
  const child = await acquireCoveredProfileRoot(target, outer)
  await writeFile(target.path, "genuine")
  await child.release()
  await mkdir(path.join(tmp.dir, "external"))
  await symlink(
    path.join(tmp.dir, "external"),
    path.join(root.path, "alias"),
    process.platform === "win32" ? "junction" : "dir",
  )
  await refuses(
    acquireCoveredProfileRoot({ kind: "json", path: path.join(root.path, "alias", "value.json") }, outer),
    "escapes",
  )
  await rename(root.path, path.join(tmp.root.path, "new", "old"))
  await mkdir(root.path)
  await refuses(acquireCoveredProfileRoot(target, outer), "identity changed")
  await refuses(outer.release(), "identity changed")
  await rmdir(root.path)
  await rename(path.join(tmp.root.path, "new", "old"), root.path)
  await outer.release()
})

test("parent release joins cleanup behind a real exact gate and preserves foreign metadata directories", async () => {
  await using tmp = await fixture()
  const outer = await acquireProfileRoot(tmp.root)
  const root = { kind: "json" as const, path: path.join(tmp.root.path, "value.json") }
  const child = await acquireCoveredProfileRoot(root, outer)
  await child.release()
  const ready = Promise.withResolvers<void>()
  const exit = Promise.withResolvers<void>()
  const gate = coordinateNativeRoots([root], async () => {
    ready.resolve()
    await exit.promise
  })
  await ready.promise
  let settled = false
  const closing = outer.release().then(() => {
    settled = true
  })
  await Bun.sleep(60)
  expect(settled).toBe(false)
  await refuses(acquireCoveredProfileRoot(root, outer), "expired")
  exit.resolve()
  await gate
  await closing
  expect(settled).toBe(true)

  const next = await acquireProfileRoot(tmp.root)
  const admitted = await acquireCoveredProfileRoot(root, next)
  await admitted.release()
  const resolved = await resolveProfileRoot(root)
  const dir = path.join(path.dirname(resolved.path), ".raya-profile-locks", Hash.fast(resolved.id) + ".writers")
  await rmdir(dir)
  const foreign = path.join(tmp.dir, "foreign")
  await mkdir(foreign)
  await writeFile(path.join(foreign, "foreign.json"), "foreign bytes must not be read as stale ownership")
  await symlink(foreign, dir, process.platform === "win32" ? "junction" : "dir")
  await refuses(next.release(), "regular directory")
  expect(await Bun.file(path.join(foreign, "foreign.json")).text()).toBe(
    "foreign bytes must not be read as stale ownership",
  )
  await unlink(dir)
  await next.release()
})

test("release failure retains namespace authority until the exact child marker can be retired", async () => {
  await using tmp = await fixture()
  const outer = await acquireProfileRoot(tmp.root)
  const root = { kind: "json" as const, path: path.join(tmp.root.path, "value.json") }
  const child = await acquireCoveredProfileRoot(root, outer)
  const resolved = await resolveProfileRoot(root)
  const dir = path.join(path.dirname(resolved.path), ".raya-profile-locks", Hash.fast(resolved.id) + ".writers")
  const names = await readdir(dir)
  expect(names).toHaveLength(1)
  const marker = path.join(dir, names[0])
  const original = await Bun.file(marker).text()
  await writeFile(marker, "changed actual marker")
  await refuses(child.release(), "changed profile operation")
  await refuses(outer.release(), "failed to release")
  expect(await Bun.file(marker).text()).toBe("changed actual marker")
  await writeFile(marker, original)
  await child.release()
  await outer.release()
  expect(await Bun.file(marker).exists()).toBe(false)
})

test("distinct covered file writes bound historical roots and retire only their empty exact writer metadata", async () => {
  await using tmp = await fixture()
  const before = ProfileRoots.snapshot().length
  const outer = await acquireProfileRoot(tmp.root)
  for (const index of Array.from({ length: 20 }, (_, index) => index)) {
    const root = { kind: "json" as const, path: path.join(tmp.root.path, `session-${index}.json`) }
    const lease = await acquireCoveredProfileRoot(root, outer)
    await writeFile(root.path, String(index))
    await rm(root.path)
    await lease.release()
  }
  await outer.release()
  expect(ProfileRoots.snapshot().length).toBe(before + 1)
  const dirs = (await readdir(path.join(tmp.root.path, ".raya-profile-locks"))).filter((name) =>
    name.endsWith(".writers"),
  )
  expect(dirs).toHaveLength(0)
})
