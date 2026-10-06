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
function selection() {
  return {
    id: crypto.randomUUID(),
    owner: crypto.randomUUID(),
    model: "local/test-model",
    sources: candidate.sources,
    timeout: 300000,
    budget: { input: 3000, output: 1000 },
  }
}

test("manual run ownership survives reload and concurrent replacement is refused", async () => {
  const f = await fixture()
  const first = selection()
  const second = selection()
  const results = await Promise.allSettled([
    f.ledger.begin(f.root, f.project, first),
    f.ledger.begin(f.root, f.project, second),
  ])
  expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1)
  const retained = (await f.ledger.list(f.root, f.project)).runs[0]
  await expect(f.ledger.begin(f.root, f.project, selection())).rejects.toThrow("original active")
  await expect(
    f.ledger.advance(f.root, f.project, { id: retained.id, owner: crypto.randomUUID(), phase: "validation" }),
  ).rejects.toThrow("owner differs")
  await f.ledger.advance(f.root, f.project, { id: retained.id, owner: retained.owner, phase: "cancelled" })
  await expect(f.ledger.begin(f.root, f.project, first.id === retained.id ? first : second)).rejects.toThrow(
    "already been used",
  )
  expect((await f.ledger.list(f.root, f.project)).runs[0].sources).toEqual(candidate.sources)
})

test("run checkpoint requires durable candidates and unknown submission cannot be hidden as completion", async () => {
  const f = await fixture()
  const selected = selection()
  await f.ledger.begin(f.root, f.project, selected)
  const owner = { id: selected.id, owner: selected.owner }
  await f.ledger.advance(f.root, f.project, { ...owner, phase: "validation" })
  await expect(
    f.ledger.advance(f.root, f.project, { ...owner, phase: "submission", candidates: [digest] }),
  ).rejects.toThrow("Retain the exact")
  const [fingerprint] = await f.ledger.stage(f.root, f.project, [candidate])
  await f.ledger.advance(f.root, f.project, { ...owner, phase: "submission", candidates: [fingerprint] })
  await f.ledger.submit(f.root, f.project, fingerprint, proposal)
  await expect(f.ledger.advance(f.root, f.project, { ...owner, phase: "cancelled" })).rejects.toThrow("reconciliation")
  await f.ledger.advance(f.root, f.project, { ...owner, phase: "reconciliation", reason: "Reply was lost" })
  await expect(f.ledger.advance(f.root, f.project, { ...owner, phase: "generation" })).rejects.toThrow("replay")
  await expect(f.ledger.advance(f.root, f.project, { ...owner, phase: "completed" })).rejects.toThrow("reconciliation")
  await f.ledger.settle(f.root, f.project, { fingerprint, proposal, state: "pending" })
  await f.ledger.advance(f.root, f.project, { ...owner, phase: "review-pending" })
  await expect(f.ledger.advance(f.root, f.project, { ...owner, phase: "completed" })).rejects.toThrow("review remains")
  await f.ledger.settle(f.root, f.project, { fingerprint, proposal, state: "rejected", reason: "Not useful" })
  await f.ledger.advance(f.root, f.project, { ...owner, phase: "completed" })
  expect((await f.ledger.list(f.root, f.project)).runs[0]).toMatchObject({
    phase: "completed",
    candidates: [fingerprint],
  })
})

test("finite run deadline refuses late generation phases while preserving failure recovery", async () => {
  const f = await fixture()
  const selected = { ...selection(), timeout: 1 }
  await f.ledger.begin(f.root, f.project, selected)
  await Bun.sleep(5)
  const owner = { id: selected.id, owner: selected.owner }
  await expect(f.ledger.advance(f.root, f.project, { ...owner, phase: "validation" })).rejects.toThrow(
    "deadline elapsed",
  )
  await f.ledger.advance(f.root, f.project, { ...owner, phase: "failed", reason: "Generation timed out" })
  expect((await f.ledger.list(f.root, f.project)).runs[0].sources).toEqual(candidate.sources)
})

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
