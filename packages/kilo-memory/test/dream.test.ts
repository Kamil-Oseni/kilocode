import { expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { MemoryFiles } from "../src/storage/store"

const digest = "a".repeat(64)
const proposal = "8ab90e0e-3e53-4e79-a278-79982fb1aa21"
const candidate = {
  fact: "b".repeat(64),
  kind: "memory" as const,
  sources: [{ path: "evidence/session.md", sha256: digest }],
  changes: [{ path: "Preferences/voice.md", expected: null, content: "Prefers a calm voice." }],
  rationale: "An explicitly approved preference.",
  contradictions: [],
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-dream-ledger-"))
  return { root, project: path.join(root, "project"), ledger: MemoryFiles.dream }
}

test("uncertain submission survives reload and cannot create a replacement", async () => {
  const f = await fixture()
  const [fingerprint] = await f.ledger.stage(f.root, f.project, [candidate])
  await f.ledger.submit(f.root, f.project, fingerprint, proposal)
  expect((await f.ledger.list(f.root, f.project)).rows[0]).toMatchObject({ state: "submitting", proposal })
  await expect(f.ledger.submit(f.root, f.project, fingerprint, proposal)).rejects.toThrow("reconcile")
  await expect(
    f.ledger.settle(f.root, f.project, { fingerprint, state: "pending", proposal: crypto.randomUUID() }),
  ).rejects.toThrow("identity differs")
  await f.ledger.settle(f.root, f.project, { fingerprint, state: "pending", proposal })
  await expect(f.ledger.settle(f.root, f.project, { fingerprint, state: "accepted", proposal })).rejects.toThrow(
    "receipt",
  )
  await f.ledger.settle(f.root, f.project, { fingerprint, state: "accepted", proposal, receipt: digest })
  expect((await f.ledger.list(f.root, f.project)).rows[0].state).toBe("accepted")
  await f.ledger.settle(f.root, f.project, {
    fingerprint,
    state: "deleted",
    proposal,
    reason: "User removed this fact",
  })
  const removed = (await f.ledger.list(f.root, f.project)).rows[0]
  expect(removed.receipt).toBe(digest)
  expect(removed.history.map((item) => item.state)).toEqual([
    "prepared",
    "submitting",
    "pending",
    "accepted",
    "deleted",
  ])
  expect(removed.history.find((item) => item.state === "accepted")?.receipt).toBe(digest)
})

test("rejections suppress identical evidence despite explanation changes", async () => {
  const f = await fixture()
  const [fingerprint] = await f.ledger.stage(f.root, f.project, [candidate, candidate])
  await f.ledger.settle(f.root, f.project, { fingerprint, state: "rejected", reason: "Incorrect preference" })
  expect(await f.ledger.stage(f.root, f.project, [{ ...candidate, rationale: "Reworded explanation" }])).toEqual([])
  expect(
    await f.ledger.stage(f.root, f.project, [
      { ...candidate, sources: [{ path: "evidence/session.md", sha256: "c".repeat(64) }] },
    ]),
  ).toHaveLength(1)
  await expect(f.ledger.submit(f.root, f.project, fingerprint, proposal)).rejects.toThrow("reconcile")
})

test("deletion persists across new evidence and blocks already pending candidates", async () => {
  const f = await fixture()
  const changed = { ...candidate, sources: [{ path: "evidence/new.md", sha256: digest }] }
  const [first, second] = await f.ledger.stage(f.root, f.project, [candidate, changed])
  await f.ledger.submit(f.root, f.project, second, proposal)
  await f.ledger.settle(f.root, f.project, { fingerprint: first, state: "deleted" })
  expect((await f.ledger.list(f.root, f.project)).tombstones).toEqual([candidate.fact])
  expect(
    await f.ledger.stage(f.root, f.project, [
      { ...changed, changes: [{ ...candidate.changes[0], content: "Reworded." }] },
    ]),
  ).toEqual([])
  await expect(
    f.ledger.settle(f.root, f.project, { fingerprint: second, state: "accepted", proposal, receipt: digest }),
  ).rejects.toThrow("Deleted fact")
})

test("wrong project, tampered revision, unsafe paths and oversized batch fail without replacing ledger", async () => {
  const f = await fixture()
  await expect(f.ledger.stage(f.root, "relative-project", [candidate])).rejects.toThrow("absolute")
  expect(await readdir(f.root)).toEqual([])
  await f.ledger.stage(f.root, f.project, [candidate])
  const file = path.join(f.root, "dream.json")
  const before = await readFile(file, "utf8")
  await expect(f.ledger.list(f.root, path.join(f.root, "other"))).rejects.toThrow("another project")
  await expect(
    f.ledger.stage(f.root, f.project, [{ ...candidate, sources: [{ path: "../outside.md", sha256: digest }] }]),
  ).rejects.toThrow()
  await expect(
    f.ledger.stage(
      f.root,
      f.project,
      Array.from({ length: 21 }, () => candidate),
    ),
  ).rejects.toThrow("1–20")
  expect(await readFile(file, "utf8")).toBe(before)
  const tampered = JSON.parse(before)
  tampered.rows[0].candidate.changes[0].content = "Unreviewed content"
  await writeFile(file, JSON.stringify(tampered))
  await expect(f.ledger.list(f.root, f.project)).rejects.toThrow("revision changed")
})

test("concurrent selections share the existing root queue and never claim duplicate candidates", async () => {
  const f = await fixture()
  const selected = await Promise.all(Array.from({ length: 5 }, () => f.ledger.stage(f.root, f.project, [candidate])))
  expect(selected.flat()).toHaveLength(1)
  expect((await f.ledger.list(f.root, f.project)).rows).toHaveLength(1)
  expect(await readdir(f.root)).toEqual(["dream.json"])
})
