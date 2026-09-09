import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Installation } from "../../src/services/update-installation"

test("persists interrupted installation and clears it only when the requested version is running", async () => {
  const root = await mkdtemp(join(tmpdir(), "raya-installation-"))
  const path = join(root, "state.json")
  const open = async () => {
    let value: unknown = JSON.parse(await readFile(path, "utf8"))
    return new Installation({
      get: <T>() => (value === null ? undefined : value) as T,
      update: async (_key, next) => {
        await writeFile(path, JSON.stringify(next ?? null))
        value = next
      },
    })
  }
  try {
    await writeFile(path, "null")
    const first = await open()
    await expect(
      first.run("1.2.3", "1.2.2", async () => {
        expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ phase: "installing", version: "1.2.3" })
        throw new Error("interrupted")
      }),
    ).rejects.toThrow("interrupted")
    const reopened = await open()
    expect(await reopened.recover("1.2.2")).toMatchObject({ version: "1.2.3", phase: "installing" })
    await reopened.run("1.2.3", "1.2.2", async () => undefined)
    expect(await (await open()).recover("1.2.2")).toMatchObject({ phase: "awaiting-reload" })
    expect(await (await open()).recover("1.2.3")).toBeUndefined()
    expect(JSON.parse(await readFile(path, "utf8"))).toBeNull()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a failed intent write prevents installation dispatch", async () => {
  let dispatched = false
  const journal = new Installation({
    get: <T>() => undefined as T,
    update: async () => {
      throw new Error("write failed")
    },
  })
  await expect(
    journal.run("1.2.3", "1.2.2", async () => {
      dispatched = true
    }),
  ).rejects.toThrow("write failed")
  expect(dispatched).toBe(false)
})

test("completion-write failure retains uncertainty and corrupt journals are not erased", async () => {
  let value: unknown
  let writes = 0
  let installs = 0
  const journal = new Installation({
    get: <T>() => value as T,
    update: async (_key, next) => {
      if (++writes === 2) throw new Error("completion persistence failed")
      value = next
    },
  })
  await expect(journal.run("1.2.3", "1.2.2", async () => { installs++ })).rejects.toThrow("completion persistence failed")
  expect(installs).toBe(1)
  expect(await journal.recover("1.2.2")).toMatchObject({ phase: "installing" })
  value = { malformed: true }
  await expect(journal.recover("1.2.3")).rejects.toThrow("invalid")
  expect(value).toEqual({ malformed: true })
  expect(writes).toBe(2)
})
