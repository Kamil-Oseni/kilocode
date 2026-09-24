import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "bun:test"
import { ComputerUseRevocationStore } from "../../src/services/computer-use/revocation-store"

const dirs: string[] = []
const directory = () => {
  const dir = mkdtempSync(join(tmpdir(), "raya-revocations-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("Computer Use revocation store", () => {
  it("persists exact lease IDs before add resolves and restores them synchronously", async () => {
    const dir = directory()
    const id = randomUUID()
    const store = new ComputerUseRevocationStore(dir)
    expect(store.has(id)).toBe(false)
    await store.add(id)
    expect(store.has(id)).toBe(true)
    expect(store.has(id.toUpperCase())).toBe(false)
    expect(new ComputerUseRevocationStore(dir).has(id)).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, "revocations.json"), "utf8"))).toEqual({ version: 1, ids: [id] })
    expect(readdirSync(dir)).toEqual(["revocations.json"])
  })

  it("serializes concurrent additions without losing a revocation", async () => {
    const dir = directory()
    const ids = Array.from({ length: 20 }, () => randomUUID())
    const store = new ComputerUseRevocationStore(dir)
    await Promise.all(ids.map((id) => store.add(id)))
    await store.add(ids[0])
    const saved = new ComputerUseRevocationStore(dir)
    expect(ids.every((id) => saved.has(id))).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, "revocations.json"), "utf8")).ids).toHaveLength(ids.length)
  })

  it("does not mark a failed write as durable and permits a later retry", async () => {
    const dir = directory()
    const id = randomUUID()
    const store = new ComputerUseRevocationStore(dir)
    rmSync(dir, { recursive: true })
    await expect(store.add(id)).rejects.toThrow()
    expect(store.has(id)).toBe(false)
    mkdirSync(dir)
    await store.add(id)
    expect(new ComputerUseRevocationStore(dir).has(id)).toBe(true)
  })

  it("rejects invalid IDs and a full record without dropping prior tombstones", async () => {
    const dir = directory()
    const ids = Array.from({ length: 1024 }, () => randomUUID())
    writeFileSync(join(dir, "revocations.json"), JSON.stringify({ version: 1, ids }))
    const store = new ComputerUseRevocationStore(dir)
    await expect(store.add("")).rejects.toThrow(/exact lease UUID/i)
    await expect(store.add("not-a-uuid")).rejects.toThrow(/exact lease UUID/i)
    await expect(store.add(randomUUID())).rejects.toThrow(/full/i)
    expect(ids.every((id) => store.has(id))).toBe(true)
    expect(new ComputerUseRevocationStore(dir).has(ids[0])).toBe(true)
  })

  it("fails closed when a saved record is corrupt or has unknown fields", () => {
    const dir = directory()
    const path = join(dir, "revocations.json")
    for (const value of [
      "{",
      "[]",
      "{}",
      JSON.stringify({ version: 1, ids: ["bad"] }),
      JSON.stringify({ version: 1, ids: [], extra: true }),
    ]) {
      writeFileSync(path, value)
      expect(() => new ComputerUseRevocationStore(dir)).toThrow()
    }
    expect(() => new ComputerUseRevocationStore("relative-revocations")).toThrow(/absolute directory/i)
  })
})
