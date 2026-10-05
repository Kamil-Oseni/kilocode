import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, basename, sep } from "node:path"
import { BrainSettings, files, parse } from "../../src/second-brain/settings"
import { sources } from "../../src/second-brain/setup-v2"
import { journal } from "../../src/second-brain/journal"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const root = "C:\\Synthetic\\Notes"
const pins = Object.fromEntries(sources.map((name) => [name, "a".repeat(64)]))
const setup = {
  format: "raya.memory.setup",
  version: 2,
  protocol: "raya.memory.operation.v1",
  origin: "http://127.0.0.1:8874",
  root,
  source_sha256: pins,
} as const
function metadata(op: "sync" | "search") {
  return {
    format: "raya.memory.control.uncertainty",
    version: 2,
    protocol: "raya.memory.operation.v1",
    root,
    request: {
      op,
      id: "b".repeat(32),
      root,
      owner_epoch: "c".repeat(32),
      selected_release_sha256: "d".repeat(64),
      bodySHA: "e".repeat(64),
      source_sha256: pins,
      ...(op === "sync" ? { expected: "f".repeat(64) } : {}),
    },
  }
}

test("separate v2 setup schema refuses cross-version, paged and incomplete maps", () => {
  expect(parse(setup)).toEqual(setup)
  const prior = Object.fromEntries(
    Object.entries(pins).filter(([name]) => !["historical.py", "dispatch.py", "proposals.py"].includes(name)),
  )
  expect(Object.keys(prior)).toHaveLength(9)
  expect(() => parse({ ...setup, source_sha256: prior })).toThrow()
  const legacy = {
    format: setup.format,
    version: 1 as const,
    origin: setup.origin,
    root,
    source_sha256: Object.fromEntries(files.map((name) => [name, "a".repeat(64)])),
  }
  expect(parse(legacy)).toEqual(legacy)
  expect(() => parse({ ...legacy, protocol: setup.protocol })).toThrow()
  expect(() => parse({ ...setup, version: 1 })).toThrow()
  expect(() => parse({ ...setup, source_sha256: legacy.source_sha256 })).toThrow()
  expect(() => parse({ ...setup, protocol: "raya.memory.operation.v2" })).toThrow()
  expect(() => parse({ ...setup, source_sha256: { ...pins, extra: "a".repeat(64) } })).toThrow()
  expect(() => parse({ ...setup, source_sha256: { ...pins, "server.py": "a".repeat(64) + "\n" } })).toThrow()
  expect(() => parse({ ...setup, origin: "http://localhost:8874" })).toThrow()
  expect(() => parse({ ...setup, root: root + "\0" })).toThrow()
})

test("v2 sync and search debts preserve exact root and refuse replay-shaped metadata", () => {
  for (const op of ["sync", "search"] as const) {
    const value = metadata(op)
    expect(journal(value)).toEqual(value)
    for (const change of [
      { op: ["search"] },
      { op: { value: "search" } },
      { op: null },
      { id: "B".repeat(32) },
      { id: "b".repeat(32) + "\n" },
      { id: crypto.randomUUID() },
      { owner_epoch: "c".repeat(31) },
      { selected_release_sha256: "d".repeat(63) },
      { bodySHA: "not-a-digest" },
      { root: "c:/synthetic/notes" },
      { source_sha256: {} },
      { replay: true },
    ])
      expect(() => journal({ ...value, request: { ...value.request, ...change } })).toThrow()
    expect(() => journal({ ...value, protocol: "raya.memory.operation.v2" })).toThrow()
    expect(() => journal({ ...value, version: 1 })).toThrow()
  }
  const search = metadata("search")
  expect(() => journal({ ...search, request: { ...search.request, expected: "f".repeat(64) } })).toThrow()
  const sync = metadata("sync")
  const { expected: _, ...request } = sync.request
  expect(() => journal({ ...sync, request })).toThrow()
})

test("real persisted v2 setup loads while durable debt refuses restarted credential use", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raya-memory-v2-schema-"))
  const file = join(dir, "state.json")
  const credential = join(dir, "synthetic-secret.json")
  const barrier = deferred()
  const began = deferred()
  let held = true
  let reads = 0
  await writeFile(file, "{}")
  await writeFile(credential, "{}")
  const store = new BrainSettings(
    {
      get<T>(name: string) {
        return JSON.parse(readFileSync(file, "utf8"))[name] as T | undefined
      },
      async update(name, value) {
        if (name === "raya.secondBrain.control.uncertainty" && held) {
          began.resolve()
          await barrier.promise
        }
        const data = JSON.parse(await readFile(file, "utf8"))
        data[name] = value
        await writeFile(file, JSON.stringify(data))
      },
    },
    {
      async get(name) {
        reads++
        return JSON.parse(await readFile(credential, "utf8"))[name]
      },
      async store(name, value) {
        const data = JSON.parse(await readFile(credential, "utf8"))
        data[name] = value
        await writeFile(credential, JSON.stringify(data))
      },
      async delete(name) {
        const data = JSON.parse(await readFile(credential, "utf8"))
        delete data[name]
        await writeFile(credential, JSON.stringify(data))
      },
    },
  )
  try {
    await store.save(setup, "synthetic-private")
    expect((await store.load())?.setup.version).toBe(2)
    expect(reads).toBe(1)
    expect(await readFile(file, "utf8")).not.toContain("synthetic-private")
    const request = metadata("search")
    const original = store.record(request)
    await began.promise
    const clearing = store.record(undefined)
    let settled = false
    void original.then(() => {
      settled = true
    })
    expect(settled).toBe(false)
    expect(store.pending()).toBeUndefined()
    held = false
    barrier.resolve()
    await original
    await clearing
    expect(store.pending()).toBeUndefined()
    await store.record(request)
    const reopened = new BrainSettings(
      {
        get<T>(name: string) {
          return JSON.parse(readFileSync(file, "utf8"))[name] as T | undefined
        },
        async update() {
          throw new Error("No replay writes permitted")
        },
      },
      {
        async get() {
          throw new Error("No restarted credential use")
        },
        async store() {
          throw new Error("No replay")
        },
        async delete() {
          throw new Error("No replay")
        },
      },
    )
    expect(reopened.pending()).toEqual(request)
    await expect(reopened.load()).rejects.toThrow("unavailable")
    expect(store.pending()).toEqual(request)
    await store.clear()
    expect(await store.load()).toBeUndefined()
    expect(store.pending()).toEqual(request)
  } finally {
    barrier.resolve()
    const target = resolve(dir)
    if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith("raya-memory-v2-schema-"))
      throw new Error("Test cleanup escaped its owned temporary directory")
    await rm(target, { recursive: true, force: true })
  }
})
