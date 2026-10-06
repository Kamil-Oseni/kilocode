import { expect, test } from "bun:test"
import { mkdtemp, readFile, readdir } from "node:fs/promises"
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
  expect(await readFile(path.join(root, "dream.json"), "utf8")).toBe(before)
  expect(await readdir(root)).toEqual(["dream.json"])
  await expect(snapshot(root, path.join(root, "foreign"), signal)).rejects.toThrow("another project")
  const controller = new AbortController()
  controller.abort()
  await expect(snapshot(root, project, controller.signal)).rejects.toThrow()
})
