import { expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { MemoryFiles } from "../src/storage/store"

const check = process.platform === "win32" ? test : test.skip
check("actual proposal cancellation and committed receipts reconcile original Dream candidates", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "raya-dream-review-"))
  const root = path.join(base, "notes")
  const project = path.join(base, "project")
  await mkdir(root)
  await mkdir(project)
  const file = path.join(project, "approved.md")
  await writeFile(file, "Explicit synthetic calm voice preference.")
  const signal = new AbortController().signal
  const candidate = {
    fact: "a".repeat(64),
    kind: "memory" as const,
    sources: [
      {
        path: "approved.md",
        sha256: createHash("sha256")
          .update(await readFile(file))
          .digest("hex"),
      },
    ],
    changes: [{ path: "Preferences/voice.md", expected: null, content: "Use a calm voice." }],
    rationale: "Explicit evidence.",
    contradictions: [],
  }
  const execute = async (command: object) => {
    const child = Bun.spawn(
      [
        "D:/Raya/Services/Packaging/Python/3.12.14/python.exe",
        "-I",
        "-S",
        "-B",
        path.join(import.meta.dir, "fixtures/dream-proposal.py"),
        path.resolve(import.meta.dir, "../../kilo-vscode/script/memory/service"),
        root,
      ],
      { stdin: new Blob([JSON.stringify(command)]), stdout: "pipe", stderr: "pipe" },
    )
    const [code, text, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (code !== 0) throw new Error(error)
    return JSON.parse(text)
  }
  const run = await MemoryFiles.dream.begin(root, project, {
    id: randomUUID(),
    owner: randomUUID(),
    model: "fixture/retired",
    sources: candidate.sources,
    timeout: 30000,
    budget: { input: 3000, output: 1000 },
  })
  await MemoryFiles.dream.advance(root, project, { id: run.id, owner: run.owner, phase: "validation" })
  const [fingerprint] = await MemoryFiles.dream.stage(root, project, [candidate])
  await MemoryFiles.dream.advance(root, project, {
    id: run.id,
    owner: run.owner,
    phase: "submission",
    candidates: [fingerprint],
  })
  const id = randomUUID()
  await MemoryFiles.dream.submit(root, project, fingerprint, id)
  const pending = await execute({
    action: "propose",
    id,
    project,
    request: {
      sources: candidate.sources.map((item) => ({ ...item, path: file, kind: "document", event_time: null })),
      changes: candidate.changes,
    },
  })
  expect(await MemoryFiles.dreamProposal.reconcile(root, project, pending, signal)).toEqual({ status: "pending" })
  expect(await MemoryFiles.dreamProposal.reconcile(root, project, pending, signal)).toEqual({ status: "pending" })
  await MemoryFiles.dream.advance(root, project, { id: run.id, owner: run.owner, phase: "review-pending" })
  const applied = await execute({ action: "apply", id, project, digest: pending.digest })
  expect(applied.receipt.status).toBe("committed")
  await expect(
    MemoryFiles.dreamProposal.reconcile(root, project, { ...applied, digest: "b".repeat(64) }, signal),
  ).rejects.toThrow("digest")
  expect(await MemoryFiles.dreamProposal.reconcile(root, project, applied, signal)).toEqual({ status: "accepted" })
  expect((await MemoryFiles.dream.list(root, project)).runs[0].phase).toBe("completed")
  const saved = await readFile(path.join(root, "dream.json"), "utf8")
  expect(await MemoryFiles.dreamProposal.reconcile(root, project, applied, signal)).toEqual({ status: "accepted" })
  expect(await readFile(path.join(root, "dream.json"), "utf8")).toBe(saved)
  await writeFile(path.join(root, "Preferences/voice.md"), "Changed after publication.")
  await expect(MemoryFiles.dreamProposal.reconcile(root, project, applied, signal)).rejects.toThrow(
    "differs from its receipt",
  )
  const changed = {
    ...candidate,
    fact: "c".repeat(64),
    changes: [{ path: "Preferences/walk.md", expected: null, content: "Take an evening walk." }],
  }
  const [second] = await MemoryFiles.dream.stage(root, project, [changed])
  const other = randomUUID()
  await MemoryFiles.dream.submit(root, project, second, other)
  const created = await execute({
    action: "propose",
    id: other,
    project,
    request: { sources: pending.sources, changes: changed.changes },
  })
  const cancelled = await execute({ action: "cancel", id: other, project, digest: created.digest })
  expect(await MemoryFiles.dreamProposal.reconcile(root, project, cancelled, signal)).toEqual({ status: "rejected" })
  expect(await MemoryFiles.dream.stage(root, project, [changed])).toEqual([])
  await expect(readFile(path.join(root, "Preferences/walk.md"))).rejects.toThrow()
  expect(
    await MemoryFiles.dreamProposal.reconcile(root, project, { id: randomUUID(), project, status: "pending" }, signal),
  ).toEqual({ status: "untracked" })
})
