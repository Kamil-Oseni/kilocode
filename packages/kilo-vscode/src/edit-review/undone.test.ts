import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { apply, forget, listed, record, reopen, scoped } from "./undone"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "raya-undone-"))
  directories.push(directory)
  const file = join(directory, "state.json")
  await writeFile(file, "{}")
  const open = async () => {
    const values = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
    return {
      get: (key: string) => values[key],
      update: async (key: string, value: unknown) => {
        const next = { ...values, [key]: value }
        await writeFile(file, JSON.stringify(next))
        Object.assign(values, next)
      },
    }
  }
  return { open, file }
}

describe("historical undo dismissals", () => {
  test("scoped revisions keep only submitted Undo files", () => {
    expect(scoped(["a.ts"], { "a.ts": "v1", "b.ts": "v2" })).toEqual({ "a.ts": "v1" })
    expect(scoped(undefined, { "a.ts": "v1", "b.ts": "v2" })).toEqual({ "a.ts": "v1", "b.ts": "v2" })
    expect(scoped(["missing.ts"], { "a.ts": "v1" })).toBeUndefined()
    expect(scoped(["a.ts"], undefined)).toBeUndefined()
  })

  test("apply hydrates absent files and marks live files stale", () => {
    expect(apply({ "live.ts": "v2" }, { "gone.ts": "undone", "live.ts": "v1" })).toEqual({
      accepted: { "gone.ts": "undone" },
      stale: ["live.ts"],
    })
  })

  test("persists Undo fingerprints across reopen and drops them when the file returns", async () => {
    const disk = await fixture()
    const state = await disk.open()
    await record(state, "session-a", { "gone.ts": "undone", "other.ts": "kept" })
    await record(state, "session-b", { "gone.ts": "other" })
    const reopened = await disk.open()
    expect(listed(reopened, "session-a")).toEqual({ "gone.ts": "undone", "other.ts": "kept" })
    await reopen(reopened, "session-a", ["gone.ts"])
    expect(listed(await disk.open(), "session-a")).toEqual({ "other.ts": "kept" })
    await forget(await disk.open(), "session-a")
    expect(listed(await disk.open(), "session-a")).toEqual({})
    expect(listed(await disk.open(), "session-b")).toEqual({ "gone.ts": "other" })
  })

  test("rejects corrupted persisted dismissals before hydrating", async () => {
    const disk = await fixture()
    await writeFile(disk.file, JSON.stringify({ "raya.reviewUndone.v1": { broken: 42 } }))
    const state = await disk.open()
    expect(() => listed(state, "session-a")).toThrow("Saved review undo dismissals could not be read")
  })
})
