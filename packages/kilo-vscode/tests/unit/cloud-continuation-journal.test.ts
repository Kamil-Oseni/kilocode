import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { CloudContinuationJournal } from "../../src/services/cloud-continuation-journal"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "raya-cloud-journal-"))
  roots.push(root)
  return { root, first: new CloudContinuationJournal(root), second: new CloudContinuationJournal(root) }
}

describe("CloudContinuationJournal", () => {
  it("admits one claimant across independent journal instances", async () => {
    const f = await fixture()
    const key = JSON.stringify(["cloud", "/repo"])
    const [first, second] = await Promise.all([
      f.first.claim(key, { claim: "11111111-1111-4111-8111-111111111111", revision: 7, created: 1 }),
      f.second.claim(key, { claim: "22222222-2222-4222-8222-222222222222", revision: 7, created: 1 }),
    ])
    expect([first.acquired, second.acquired].filter(Boolean)).toHaveLength(1)
    expect(first.record.claim).toBe(second.record.claim)
  })

  it("only lets the owner complete or clear a reservation", async () => {
    const f = await fixture()
    const key = JSON.stringify(["cloud", "/repo"])
    const claim = "11111111-1111-4111-8111-111111111111"
    await f.first.claim(key, { claim, revision: 7, created: 1 })
    expect(await f.second.clear(key, "22222222-2222-4222-8222-222222222222")).toBe(false)
    expect(f.second.complete(key, "22222222-2222-4222-8222-222222222222", "local")).rejects.toThrow()
    await f.first.complete(key, claim, "local")
    expect(await f.second.get(key)).toMatchObject({ claim, revision: 7, sessionID: "local" })
  })

  it("retains invalid state and fails closed", async () => {
    const f = await fixture()
    await writeFile(join(f.root, "continuations.json"), '{"version":1,"records":{"key":{}}}')
    expect(f.first.get("key")).rejects.toThrow("invalid and was retained")
  })
})
