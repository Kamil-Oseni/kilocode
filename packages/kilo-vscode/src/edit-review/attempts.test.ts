import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { forget, remember } from "./attempts"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "raya-attempts-"))
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

const input = {
  request: "original",
  session: "session",
  directory: "workspace",
  action: "undo" as const,
  files: ["file.ts"],
  expected: { "file.ts": "revision" },
}

describe("persistent review attempts", () => {
  test("deletion removes only the owning session's persisted attempts", async () => {
    const disk = await fixture()
    const state = await disk.open()
    await Promise.all([
      remember(state, input),
      remember(state, { ...input, action: "keep", request: "keep" }),
      remember(state, { ...input, session: "other", request: "other" }),
    ])
    await forget(state, input.session)
    const reopened = await disk.open()
    expect((await remember(reopened, { ...input, request: "fresh" })).id).toBe("fresh")
    expect((await remember(reopened, { ...input, session: "other", request: "retry" })).id).toBe("other")
  })

  test("legacy entries retain their retry identity and acquire ownership only when matched", async () => {
    const disk = await fixture()
    const state = await disk.open()
    await remember(state, input)
    const saved = JSON.parse(await readFile(disk.file, "utf8")) as Record<string, Record<string, unknown>>
    const key = Object.keys(saved["raya.reviewAttempts.v1"])[0]
    saved["raya.reviewAttempts.v1"] = { [key]: "legacy", unrelated: "unattributable" }
    await writeFile(disk.file, JSON.stringify(saved))
    const reopened = await disk.open()
    await forget(reopened, input.session)
    expect((await remember(reopened, { ...input, request: "restart" })).id).toBe("legacy")
    await forget(reopened, input.session)
    const remaining = JSON.parse(await readFile(disk.file, "utf8"))
    expect(remaining["raya.reviewAttempts.v1"]).toEqual({ unrelated: "unattributable" })
  })

  test("recovers the original identity after reopening persisted state", async () => {
    const disk = await fixture()
    const first = await remember(await disk.open(), input)
    expect(first.recovered).toBe(false)
    const state = await disk.open()
    const recovered = await remember(state, { ...input, request: "restart" })
    expect(recovered.id).toBe("original")
    expect(recovered.recovered).toBe(true)
    const other = await remember(state, { ...input, action: "keep", request: "keep" })
    await recovered.complete()
    const reopened = await disk.open()
    expect((await remember(reopened, { ...input, request: "new" })).id).toBe("new")
    expect((await remember(reopened, { ...input, action: "keep", request: "another" })).id).toBe(other.id)
  })

  test("serializes simultaneous claims and preserves different revisions", async () => {
    const disk = await fixture()
    const state = await disk.open()
    const results = await Promise.all([
      remember(state, input),
      remember(state, { ...input, request: "duplicate" }),
      remember(state, { ...input, request: "changed", expected: { "file.ts": "new" } }),
    ])
    expect(results.map((result) => result.id)).toEqual(["original", "original", "changed"])
    const reopened = await disk.open()
    expect((await remember(reopened, { ...input, request: "restart" })).id).toBe("original")
    expect((await remember(reopened, { ...input, request: "restart", expected: { "file.ts": "new" } })).id).toBe(
      "changed",
    )
  })

  test("rejects corrupted persisted state before authorizing dispatch", async () => {
    const disk = await fixture()
    await writeFile(disk.file, JSON.stringify({ "raya.reviewAttempts.v1": { broken: 42 } }))
    await expect(remember(await disk.open(), input)).rejects.toThrow("Saved review attempts could not be read")
  })

  test("rejects a validly shaped entry attributed to the wrong session", async () => {
    const disk = await fixture()
    await remember(await disk.open(), input)
    const saved = JSON.parse(await readFile(disk.file, "utf8")) as Record<
      string,
      Record<string, { id: string; session: string }>
    >
    for (const entry of Object.values(saved["raya.reviewAttempts.v1"])) entry.session = "0".repeat(64)
    await writeFile(disk.file, JSON.stringify(saved))
    await expect(remember(await disk.open(), input)).rejects.toThrow("ownership does not match")
  })

  test("failed persistence cannot return an authorized attempt", async () => {
    const disk = await fixture()
    const state = await disk.open()
    await rm(disk.file)
    await rm(join(disk.file, ".."), { recursive: true })
    await expect(remember(state, input)).rejects.toThrow()
  })
})
