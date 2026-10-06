import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { MemoryFiles } from "@kilocode/kilo-memory/store"
import { explanation } from "../../src/second-brain/dream-review"
import type { BrainProposal } from "../../src/shared/second-brain"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("raya-dream-review-"))
        throw new Error("Private review cleanup escaped its root")
      await rm(root, { recursive: true })
    }),
  )
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-dream-review-"))
  roots.push(root)
  const project = path.join(root, "project")
  const candidate = {
    fact: "a".repeat(64),
    kind: "lesson" as const,
    sources: [{ path: "approved.md", sha256: "b".repeat(64) }],
    changes: [{ path: "Lessons/recovery.md", expected: null, content: "A proposed recovery hypothesis." }],
    rationale: "Based on the explicitly selected failed run.",
    contradictions: ["Successful recovery is not yet verified."],
  }
  const [fingerprint] = await MemoryFiles.dream.stage(root, project, [candidate])
  const id = crypto.randomUUID()
  await MemoryFiles.dream.submit(root, project, fingerprint, id)
  await MemoryFiles.dream.settle(root, project, { fingerprint, proposal: id, state: "pending" })
  const proposal: BrainProposal = {
    format: "raya.memory.proposal.v1",
    id,
    project,
    digest: "c".repeat(64),
    status: "pending",
    capture_enabled: false,
    provenance: "Synthetic private source",
    sources: [{ path: path.join(project, "approved.md"), sha256: "b".repeat(64), kind: "document", event_time: null }],
    changes: [{ ...candidate.changes[0], before: null }],
  }
  return { root, project, candidate, proposal, fingerprint, signal: new AbortController().signal }
}

test("review explanation uses the actual saved candidate without changing either signed proposal or ledger", async () => {
  const cfg = await fixture()
  const before = await readFile(path.join(cfg.root, "dream.json"), "utf8")
  const original = structuredClone(cfg.proposal)
  const result = await explanation(cfg.root, cfg.project, cfg.proposal, cfg.signal)
  expect(result).toEqual({
    id: cfg.proposal.id,
    digest: cfg.proposal.digest,
    fingerprint: cfg.fingerprint,
    kind: "lesson",
    rationale: cfg.candidate.rationale,
    contradictions: cfg.candidate.contradictions,
  })
  expect(cfg.proposal).toEqual(original)
  expect(await readFile(path.join(cfg.root, "dream.json"), "utf8")).toBe(before)
  await expect(explanation(cfg.root, cfg.project, { ...cfg.proposal, project: "foreign" }, cfg.signal)).rejects.toThrow(
    "another project",
  )
  const controller = new AbortController()
  controller.abort()
  await expect(explanation(cfg.root, cfg.project, cfg.proposal, controller.signal)).rejects.toThrow()
})

test("reused IDs, altered evidence, changed baselines and corrected note revisions never display an old explanation", async () => {
  const cfg = await fixture()
  expect(
    await explanation(cfg.root, cfg.project, { ...cfg.proposal, id: crypto.randomUUID() }, cfg.signal),
  ).toBeUndefined()
  for (const source of [
    { ...cfg.proposal.sources[0], sha256: "d".repeat(64) },
    { ...cfg.proposal.sources[0], kind: "assistant_interpretation" as const },
    { ...cfg.proposal.sources[0], event_time: "2026-10-06" },
    { ...cfg.proposal.sources[0], path: path.join(cfg.project, "another.md") },
  ])
    expect(await explanation(cfg.root, cfg.project, { ...cfg.proposal, sources: [source] }, cfg.signal)).toBeUndefined()
  for (const change of [
    { ...cfg.proposal.changes[0], expected: "d".repeat(64) },
    { ...cfg.proposal.changes[0], content: "Different advice." },
    { ...cfg.proposal.changes[0], path: "Lessons/another.md" },
  ])
    expect(await explanation(cfg.root, cfg.project, { ...cfg.proposal, changes: [change] }, cfg.signal)).toBeUndefined()
  const changes = [{ ...cfg.candidate.changes[0], content: "User corrected the suggestion." }]
  const fingerprint = await MemoryFiles.dream.revise(cfg.root, cfg.project, cfg.proposal.id, {
    ...cfg.candidate,
    changes,
  })
  expect(await explanation(cfg.root, cfg.project, cfg.proposal, cfg.signal)).toBeUndefined()
  const result = await explanation(
    cfg.root,
    cfg.project,
    { ...cfg.proposal, digest: "e".repeat(64), changes: [{ ...changes[0], before: null }] },
    cfg.signal,
  )
  expect(result?.fingerprint).toBe(fingerprint)
  expect(result?.digest).toBe("e".repeat(64))
})
