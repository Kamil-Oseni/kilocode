import { afterEach, expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { MemoryFiles } from "../src/storage/store"

const check = process.platform === "win32" ? test : test.skip
const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("raya-dream-delete-"))
        throw new Error("Private deletion fixture escaped its root")
      await rm(root, { recursive: true })
    }),
  )
})

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "raya-dream-delete-"))
  roots.push(base)
  const root = path.join(base, "notes")
  const project = path.join(base, "project")
  await Promise.all([mkdir(root), mkdir(project)])
  await mkdir(path.join(root, "Preferences"))
  await writeFile(path.join(project, "approved.md"), "Explicit synthetic approved source.")
  const candidate = {
    fact: "a".repeat(64),
    kind: "memory" as const,
    sources: [
      { path: "approved.md", sha256: createHash("sha256").update("Explicit synthetic approved source.").digest("hex") },
    ],
    changes: [
      {
        path: "Preferences/preference.md",
        expected: createHash("sha256").update("Old preference.").digest("hex"),
        content: null,
      },
    ],
    rationale: "User reviewed deletion of this fact.",
    contradictions: [],
  }
  await writeFile(path.join(root, "Preferences/preference.md"), "Old preference.")
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
      { windowsHide: true, stdin: new Blob([JSON.stringify(command)]), stdout: "pipe", stderr: "pipe" },
    )
    const [code, text, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (code !== 0) throw new Error(error)
    return JSON.parse(text)
  }
  const publish = async (value: Parameters<typeof MemoryFiles.dream.stage>[2][number]) => {
    const [fingerprint] = await MemoryFiles.dream.stage(root, project, [value])
    const id = randomUUID()
    await MemoryFiles.dream.submit(root, project, fingerprint, id)
    const pending = await execute({
      action: "propose",
      id,
      project,
      request: {
        sources: value.sources.map((source) => ({
          ...source,
          path: path.join(project, source.path),
          kind: "document",
          event_time: null,
        })),
        changes: value.changes,
      },
    })
    return { fingerprint, id, pending }
  }
  return { root, project, candidate, execute, publish, signal: new AbortController().signal }
}

check(
  "actual committed deletion atomically preserves its receipt and suppresses later evidence without replay",
  async () => {
    const cfg = await fixture()
    const { pending, id } = await cfg.publish(cfg.candidate)
    const cancelled = await cfg.execute({ action: "cancel", id, project: cfg.project, digest: pending.digest })
    expect(await MemoryFiles.dreamProposal.reconcile(cfg.root, cfg.project, cancelled, cfg.signal)).toEqual({
      status: "rejected",
    })
    expect(await readFile(path.join(cfg.root, "Preferences/preference.md"), "utf8")).toBe("Old preference.")
    expect((await MemoryFiles.dream.list(cfg.root, cfg.project)).tombstones).toEqual([])

    const candidate = { ...cfg.candidate, fact: "b".repeat(64) }
    const next = await cfg.publish(candidate)
    const applied = await cfg.execute({
      action: "apply",
      id: next.id,
      project: cfg.project,
      digest: next.pending.digest,
    })
    expect(applied.receipt.note_sha256).toEqual({ "Preferences/preference.md": null })
    expect(await MemoryFiles.dreamProposal.reconcile(cfg.root, cfg.project, applied, cfg.signal)).toEqual({
      status: "deleted",
    })
    const saved = await MemoryFiles.dream.list(cfg.root, cfg.project)
    const row = saved.rows.find((item) => item.proposal === next.id)!
    expect(row.state).toBe("deleted")
    expect(row.history.map((item) => item.state)).toEqual(["prepared", "submitting", "accepted", "deleted"])
    expect(row.history.at(-2)?.receipt).toBe(row.receipt)
    expect(row.history.at(-1)?.receipt).toBe(row.receipt)
    expect(saved.tombstones).toEqual([candidate.fact])
    await expect(readFile(path.join(cfg.root, "Preferences/preference.md"))).rejects.toThrow()
    const before = await readFile(path.join(cfg.root, "dream.json"), "utf8")
    expect(await MemoryFiles.dreamProposal.reconcile(cfg.root, cfg.project, applied, cfg.signal)).toEqual({
      status: "deleted",
    })
    expect(await readFile(path.join(cfg.root, "dream.json"), "utf8")).toBe(before)
    expect(
      await MemoryFiles.dream.stage(cfg.root, cfg.project, [
        {
          ...candidate,
          sources: [{ ...candidate.sources[0], sha256: "c".repeat(64) }],
          changes: [{ path: "recreated.md", expected: null, content: "Do not resurrect." }],
        },
      ]),
    ).toEqual([])

    // A private legacy checkpoint retains the real original receipt, before suppression was wired.
    row.state = "accepted"
    row.reason = undefined
    row.history.pop()
    saved.tombstones = []
    await writeFile(path.join(cfg.root, "dream.json"), JSON.stringify(saved))
    expect(await MemoryFiles.dreamProposal.reconcile(cfg.root, cfg.project, applied, cfg.signal)).toEqual({
      status: "deleted",
    })
    expect((await MemoryFiles.dream.list(cfg.root, cfg.project)).tombstones).toEqual([candidate.fact])
    await writeFile(path.join(cfg.root, "Preferences/preference.md"), "Externally changed after publication.")
    await expect(MemoryFiles.dreamProposal.reconcile(cfg.root, cfg.project, applied, cfg.signal)).rejects.toThrow(
      "differs from its receipt",
    )
    expect((await MemoryFiles.dream.list(cfg.root, cfg.project)).tombstones).toEqual([candidate.fact])
  },
)

check(
  "mixed deletion and replacement preserves a remembered fact rather than treating a move as forgetting",
  async () => {
    const cfg = await fixture()
    const candidate = {
      ...cfg.candidate,
      changes: [
        ...cfg.candidate.changes,
        { path: "Preferences/moved.md", expected: null, content: "Keep this remembered preference." },
      ],
    }
    const { id, pending } = await cfg.publish(candidate)
    const applied = await cfg.execute({ action: "apply", id, project: cfg.project, digest: pending.digest })
    expect(await MemoryFiles.dreamProposal.reconcile(cfg.root, cfg.project, applied, cfg.signal)).toEqual({
      status: "accepted",
    })
    const saved = await MemoryFiles.dream.list(cfg.root, cfg.project)
    expect(saved.rows[0].state).toBe("accepted")
    expect(saved.tombstones).toEqual([])
  const note = await readFile(path.join(cfg.root, "Preferences/moved.md"))
  expect(note.toString()).toStartWith("Keep this remembered preference.")
  expect(createHash("sha256").update(note).digest("hex")).toBe(applied.receipt.note_sha256["Preferences/moved.md"])
    await expect(readFile(path.join(cfg.root, "Preferences/preference.md"))).rejects.toThrow()
  },
)
