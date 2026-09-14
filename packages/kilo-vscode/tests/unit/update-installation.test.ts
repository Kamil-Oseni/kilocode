import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Installation, type InstallRequest } from "../../src/services/update-installation"

const memory = () => {
  const state: { value?: unknown } = {}
  return {
    state,
    store: {
      get: () => state.value,
      update: async (_key: string, value: unknown) => {
        state.value = value
      },
    },
  }
}

const input = (root: string, digest = "a".repeat(64)): InstallRequest => ({
  schema: 2,
  version: "1.2.3",
  previous: "1.2.2",
  repo: "eden/raya",
  target: "win32-x64",
  asset: {
    name: "raya-win32-x64.vsix",
    url: "https://api.github.com/repos/eden/raya/releases/assets/123",
    size: 42,
    digest: `sha256:${digest}`,
  },
  artifact: { digest, size: 42 },
  package: join(root, `raya.${digest}.vsix`),
})

test("retains an interrupted dispatch and never replays its uncertain side effect", async () => {
  const root = await mkdtemp(join(tmpdir(), "raya-installation-"))
  const first = memory()
  try {
    await expect(
      new Installation(first.store, root).run(input(root), async () => {
        throw new Error("installer acknowledgement lost")
      }),
    ).rejects.toThrow("acknowledgement lost")

    const reopened = new Installation(memory().store, root)
    expect(await reopened.recover("1.2.2")).toMatchObject({ phase: "installing", version: "1.2.3" })
    let replayed = false
    expect(
      await reopened.run(input(root), async () => {
        replayed = true
      }),
    ).toMatchObject({ dispatched: false, record: { phase: "installing" } })
    expect(replayed).toBe(false)
    expect(await reopened.recover("1.2.3")).toBeUndefined()
    await expect(readFile(join(root, "update-installation.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a failed intent write prevents installation dispatch", async () => {
  let dispatched = false
  const journal = new Installation({
    get: () => undefined,
    update: async () => {
      throw new Error("write failed")
    },
  })
  await expect(
    journal.run(input(tmpdir()), async () => {
      dispatched = true
    }),
  ).rejects.toThrow("write failed")
  expect(dispatched).toBe(false)
})

test("a release asset and retained package receipt must identify the same bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "raya-installation-"))
  let dispatched = false
  try {
    const mismatched = { ...input(root), artifact: { digest: "b".repeat(64), size: 42 } }
    expect(() =>
      new Installation(memory().store, root).run(mismatched, async () => {
        dispatched = true
      }),
    ).toThrow("receipt does not match")
    expect(dispatched).toBe(false)
    await expect(readFile(join(root, "update-installation.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("completion-write failure retains uncertainty and malformed records are not erased", async () => {
  const saved = memory()
  let writes = 0
  let installs = 0
  const journal = new Installation({
    get: saved.store.get,
    update: async (_key, value) => {
      if (++writes === 2) throw new Error("completion persistence failed")
      saved.state.value = value
    },
  })
  await expect(
    journal.run(input(tmpdir()), async () => {
      installs++
    }),
  ).rejects.toThrow("completion persistence failed")
  expect(installs).toBe(1)
  expect(await journal.recover("1.2.2")).toMatchObject({ phase: "installing" })
  saved.state.value = { malformed: true }
  await expect(journal.recover("1.2.3")).rejects.toThrow("invalid")
  expect(saved.state.value).toEqual({ malformed: true })
  expect(writes).toBe(2)
})

test("a malformed filesystem record is retained and a changed package cannot take over", async () => {
  const root = await mkdtemp(join(tmpdir(), "raya-installation-"))
  const path = join(root, "update-installation.json")
  try {
    await writeFile(path, "not json")
    await expect(new Installation(memory().store, root).recover("1.2.3")).rejects.toThrow("invalid")
    expect(await readFile(path, "utf8")).toBe("not json")
    await rm(path)
    const journal = new Installation(memory().store, root)
    await journal.run(input(root), async () => undefined)
    await expect(journal.run(input(root, "b".repeat(64)), async () => undefined)).rejects.toThrow(
      "different verified package",
    )
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      phase: "awaiting-reload",
      artifact: { digest: "a".repeat(64) },
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function child(root: string, log: string, mode: "complete" | "fail") {
  const path = join(import.meta.dir, "../fixtures/update-installation-child.ts")
  const proc = Bun.spawn([process.execPath, path, root, log, mode], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, code }
}

test("one filesystem owner dispatches across independent extension processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "raya-installation-process-"))
  const log = join(root, "dispatches.log")
  try {
    const results = await Promise.all([child(root, log, "complete"), child(root, log, "complete")])
    expect(results.map((value) => value.code)).toEqual([0, 0])
    expect(results.map((value) => JSON.parse(value.stdout).dispatched).sort((a, b) => Number(a) - Number(b))).toEqual([
      false,
      true,
    ])
    expect((await readFile(log, "utf8")).trim().split(/\r?\n/)).toHaveLength(1)
    expect(await new Installation(memory().store, root).recover("1.2.2")).toMatchObject({
      phase: "awaiting-reload",
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a second process suppresses replay after installer acknowledgement is lost", async () => {
  const root = await mkdtemp(join(tmpdir(), "raya-installation-process-"))
  const log = join(root, "dispatches.log")
  try {
    const failed = await child(root, log, "fail")
    expect(failed.code).toBe(2)
    const retry = await child(root, log, "complete")
    expect(retry.code).toBe(0)
    expect(JSON.parse(retry.stdout)).toMatchObject({ dispatched: false, phase: "installing" })
    expect((await readFile(log, "utf8")).trim().split(/\r?\n/)).toHaveLength(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
