import { expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { MemoryFiles } from "@kilocode/kilo-memory/store"
import { snapshot } from "../../src/second-brain/dream-view"

test("saved Dream inspection reports actual evidence and review history without changing the ledger", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-dream-view-"))
  const project = path.join(root, "project")
  const signal = new AbortController().signal
  const [fingerprint] = await MemoryFiles.dream.stage(root, project, [
    {
      fact: "a".repeat(64),
      kind: "lesson",
      sources: [{ path: "approved.md", sha256: "b".repeat(64) }],
      changes: [{ path: "Lessons/recovery.md", expected: null, content: "A proposed recovery hypothesis." }],
      rationale: "Based on the explicitly selected failed run.",
      contradictions: ["Successful recovery is not yet verified."],
    },
  ])
  const proposal = crypto.randomUUID()
  await MemoryFiles.dream.submit(root, project, fingerprint, proposal)
  const before = await readFile(path.join(root, "dream.json"), "utf8")
  const view = JSON.parse(await snapshot(root, project, signal))
  expect(view.notice).toContain("not live worker")
  expect(view.proposals[0].state).toBe("submitting")
  expect(view.proposals[0].proposal).toBe(proposal)
  expect(view.proposals[0].candidate.contradictions).toEqual(["Successful recovery is not yet verified."])
  expect(view.proposals[0].history.at(-1).state).toBe("submitting")
  expect(view.inspection.counts).toEqual({ pendingReview: 0, unconfirmedCreation: 1 })
  expect(view.inspection.originalProposals[0]).toMatchObject({
    id: proposal,
    recordedState: "submitting",
    linkedToRun: false,
  })
  expect(view.inspection.originalProposals[0].next).toContain("do not create a replacement")
  expect(await readFile(path.join(root, "dream.json"), "utf8")).toBe(before)
  expect(await readdir(root)).toEqual(["dream.json"])
  await expect(snapshot(root, path.join(root, "foreign"), signal)).rejects.toThrow("another project")
  const controller = new AbortController()
  controller.abort()
  await expect(snapshot(root, project, controller.signal)).rejects.toThrow()
})

test("checkpoint guidance preserves cancelled pending work and original run identities", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-dream-triage-"))
  const project = path.join(root, "project")
  const source = { path: "approved.md", sha256: "b".repeat(64) }
  const run = await MemoryFiles.dream.begin(root, project, {
    id: crypto.randomUUID(),
    owner: crypto.randomUUID(),
    model: "fixture/model",
    sources: [source],
    budget: { input: 3000, output: 1000 },
    timeout: 30000,
  })
  await MemoryFiles.dream.advance(root, project, { id: run.id, owner: run.owner, phase: "validation" })
  const [fingerprint] = await MemoryFiles.dream.stage(root, project, [
    {
      fact: "c".repeat(64),
      kind: "memory",
      sources: [source],
      changes: [{ path: "Preferences/style.md", expected: null, content: "Synthetic preference." }],
      rationale: "Approved fixture source",
      contradictions: [],
    },
  ])
  await MemoryFiles.dream.advance(root, project, {
    id: run.id,
    owner: run.owner,
    phase: "submission",
    candidates: [fingerprint],
  })
  const proposal = crypto.randomUUID()
  await MemoryFiles.dream.submit(root, project, fingerprint, proposal)
  const unresolved = JSON.parse(await snapshot(root, project, new AbortController().signal))
  expect(unresolved.inspection.originalRuns[0]).toMatchObject({
    id: run.id,
    owner: run.owner,
    recordedPhase: "submission",
    originalProposalIds: [proposal],
  })
  expect(unresolved.inspection.originalRuns[0].next).toContain("do not replay")
  await MemoryFiles.dream.settle(root, project, { fingerprint, proposal, state: "pending" })
  await MemoryFiles.dream.advance(root, project, { id: run.id, owner: run.owner, phase: "cancelled" })
  const before = await readFile(path.join(root, "dream.json"), "utf8")
  const cancelled = JSON.parse(await snapshot(root, project, new AbortController().signal))
  expect(cancelled.inspection.counts).toEqual({ pendingReview: 1, unconfirmedCreation: 0 })
  expect(cancelled.inspection.originalRuns[0].recordedPhase).toBe("cancelled")
  expect(cancelled.inspection.originalRuns[0].next).toContain("preserved after cancellation")
  expect(cancelled.inspection.originalProposals[0]).toMatchObject({
    id: proposal,
    recordedState: "pending",
    linkedToRun: true,
  })
  expect(await readFile(path.join(root, "dream.json"), "utf8")).toBe(before)
  expect(await readdir(root)).toEqual(["dream.json"])
})

test("a prepared record carrying an original ID is never described as unsubmitted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-dream-prepared-"))
  const project = path.join(root, "project")
  await MemoryFiles.dream.stage(root, project, [
    {
      fact: "d".repeat(64),
      kind: "memory",
      sources: [{ path: "approved.md", sha256: "b".repeat(64) }],
      changes: [{ path: "Preferences/style.md", expected: null, content: "Synthetic preference." }],
      rationale: "Approved fixture source",
      contradictions: [],
    },
  ])
  const file = path.join(root, "dream.json")
  const saved = JSON.parse(await readFile(file, "utf8"))
  const proposal = crypto.randomUUID()
  // Schema-valid historical anomaly in a disposable ledger, not a publication receipt.
  saved.rows[0].proposal = proposal
  saved.rows[0].history.at(-1).proposal = proposal
  await writeFile(file, JSON.stringify(saved))
  const before = await readFile(file, "utf8")
  const view = JSON.parse(await snapshot(root, project, new AbortController().signal))
  expect(view.inspection.unsubmitted).toEqual([])
  expect(view.inspection.originalProposals[0].id).toBe(proposal)
  expect(view.inspection.originalProposals[0].next).toContain("prepared record includes an original proposal ID")
  expect(view.inspection.originalProposals[0].next).toContain("do not create a replacement")
  expect(await readFile(file, "utf8")).toBe(before)
})
