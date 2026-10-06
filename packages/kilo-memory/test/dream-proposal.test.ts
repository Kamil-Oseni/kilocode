import { expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { MemoryFiles } from "../src/storage/store"

const python = "D:/Raya/Services/Packaging/Python/3.12.14/python.exe"
const service = path.resolve(import.meta.dir, "../../kilo-vscode/script/memory/service")
const check = process.platform === "win32" ? test : test.skip

check("Dream pending submission uses the actual proposal store and refuses altered original replies", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-dream-proposal-"))
  const project = path.join(root, "project")
  const notes = path.join(root, "notes")
  await mkdir(project)
  await mkdir(notes)
  const file = path.join(project, "approved.md")
  await writeFile(file, "Approved synthetic calm voice preference.")
  const input = await MemoryFiles.dreamInput.prepare(notes, project, {
    scope: randomUUID(),
    sources: [
      {
        path: "approved.md",
        sha256: createHash("sha256")
          .update(await readFile(file))
          .digest("hex"),
        kind: "approved-summary",
      },
    ],
    targets: [{ key: "voice", path: "Preferences/voice.md", expected: null }],
    budget: 3000,
  })
  const [candidate] = await input.decode(
    JSON.stringify({
      items: [
        {
          key: "voice",
          sources: ["approved.md"],
          content: "Use a calm voice.",
          rationale: "Explicit synthetic evidence.",
          contradictions: [],
        },
      ],
    }),
  )
  const execute: Parameters<typeof MemoryFiles.dreamProposal.submit>[3] = async (command, signal) => {
    signal.throwIfAborted()
    const child = Bun.spawn(
      [python, "-I", "-S", "-B", path.join(import.meta.dir, "fixtures/dream-proposal.py"), service, notes],
      { stdin: new Blob([JSON.stringify(command)]), stdout: "pipe", stderr: "pipe" },
    )
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (code !== 0) throw new Error(error)
    return JSON.parse(output)
  }
  const selection = {
    id: randomUUID(),
    owner: randomUUID(),
    model: "controlled-generation",
    sources: input.sources,
    budget: { input: 3000, output: 1000 },
    timeout: 30000,
  }
  const run = await MemoryFiles.dreamJob.start(notes, project, selection, {
    admit: async () => ({ generate: async () => [candidate], retire: async () => {} }),
    validate: (value, signal) => input.validate(value, signal),
    propose: (id, value, signal) => MemoryFiles.dreamProposal.submit(project, id, value, execute, signal),
  })
  expect(run.phase).toBe("review-pending")
  const ledger = await MemoryFiles.dream.list(notes, project)
  const saved = JSON.parse(
    await readFile(path.join(notes, "System/Proposals", `${ledger.rows[0].proposal}.json`), "utf8"),
  )
  expect(saved.status).toBe("pending")
  expect(saved.id).toBe(ledger.rows[0].proposal)
  expect(saved.changes[0].content).toBe("Use a calm voice.")
  expect(await readdir(notes)).not.toContain("Preferences")
  // Mutations alter a real persisted reply; they do not reproduce proposal-store logic.
  for (const value of [
    { ...saved, id: randomUUID() },
    { ...saved, project: root },
    { ...saved, status: "applied" },
    { ...saved, changes: [{ ...saved.changes[0], content: "Different content" }] },
    { ...saved, changes: [{ ...saved.changes[0], before: "Unapproved baseline" }] },
    { ...saved, sources: [{ ...saved.sources[0], sha256: "b".repeat(64) }] },
  ]) {
    await expect(
      MemoryFiles.dreamProposal.submit(project, saved.id, candidate, async () => value, new AbortController().signal),
    ).rejects.toThrow()
  }
  // A successful durable write followed by a lost reply must retain its original ID.
  await MemoryFiles.dream.advance(notes, project, { id: run.id, owner: run.owner, phase: "cancelled" })
  const changed = { ...candidate, changes: [{ ...candidate.changes[0], content: "Use an unhurried calm voice." }] }
  await expect(
    MemoryFiles.dreamJob.start(
      notes,
      project,
      { ...selection, id: randomUUID() },
      {
        admit: async () => ({ generate: async () => [changed], retire: async () => {} }),
        validate: (value, signal) => input.validate(value, signal),
        propose: (id, value, signal) =>
          MemoryFiles.dreamProposal.submit(
            project,
            id,
            value,
            async (command, current) => {
              await execute(command, current)
              throw new Error("Original reply lost")
            },
            signal,
          ),
      },
    ),
  ).rejects.toThrow("Original reply lost")
  const retained = await MemoryFiles.dream.list(notes, project)
  const uncertain = retained.rows.find((row) => row.state === "submitting")!
  expect(retained.runs.at(-1)?.phase).toBe("reconciliation")
  expect(
    JSON.parse(await readFile(path.join(notes, "System/Proposals", `${uncertain.proposal}.json`), "utf8")).id,
  ).toBe(uncertain.proposal)
  await expect(
    MemoryFiles.dreamJob.start(
      notes,
      project,
      { ...selection, id: randomUUID() },
      {
        admit: async () => {
          throw new Error("Replacement must not start")
        },
        validate: (value, signal) => input.validate(value, signal),
        propose: async () => {
          throw new Error("Replacement must not submit")
        },
      },
    ),
  ).rejects.toThrow("original active")
  expect(await readdir(notes)).not.toContain("Preferences")
})
