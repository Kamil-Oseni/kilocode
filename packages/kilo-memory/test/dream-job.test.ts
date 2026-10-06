import { expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { MemoryFiles } from "../src/storage/store"

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-dream-job-"))
  const project = path.join(root, "project")
  await mkdir(path.join(project, "evidence"), { recursive: true })
  const file = path.join(project, "evidence", "session.md")
  await writeFile(file, "An approved synthetic preference: calm voice.")
  const sha256 = createHash("sha256")
    .update(await readFile(file))
    .digest("hex")
  const candidate = {
    fact: "a".repeat(64),
    kind: "memory" as const,
    sources: [{ path: "evidence/session.md", sha256 }],
    changes: [{ path: "Preferences/voice.md", expected: null, content: "Prefers a calm voice." }],
    rationale: "An approved synthetic preference.",
    contradictions: [],
  }
  const selection = {
    id: randomUUID(),
    owner: randomUUID(),
    model: "controlled-file-fixture",
    sources: candidate.sources,
    timeout: 300000,
    budget: { input: 3000, output: 1000 },
  }
  const events: string[] = []
  const ports: Parameters<typeof MemoryFiles.dreamJob.start>[3] = {
    admit: async () => ({
      // Controlled generation fixture, not an inference or scheduler acceptance test.
      generate: async () => {
        await readFile(file)
        events.push("generated")
        return [candidate]
      },
      retire: async () => {
        events.push("retired")
      },
    }),
    validate: async (value) => {
      for (const source of value.sources) {
        const current = createHash("sha256")
          .update(await readFile(path.join(project, source.path)))
          .digest("hex")
        if (current !== source.sha256) throw new Error("Source revision changed")
      }
      events.push("validated")
    },
    propose: async (id, value) => {
      await writeFile(path.join(root, `${id}.proposal.json`), JSON.stringify(value), { flag: "wx" })
      events.push("proposed")
      return { id, status: "pending" }
    },
  }
  return { root, project, file, candidate, selection, ports, events }
}

test("manual job retains original pending proposal and never applies generated notes", async () => {
  const f = await fixture()
  await MemoryFiles.dreamJob.start(f.root, f.project, f.selection, f.ports)
  const ledger = await MemoryFiles.dream.list(f.root, f.project)
  expect(ledger.runs[0].phase).toBe("review-pending")
  expect(ledger.rows[0].state).toBe("pending")
  expect(JSON.parse(await readFile(path.join(f.root, `${ledger.rows[0].proposal}.proposal.json`), "utf8"))).toEqual(
    f.candidate,
  )
  expect(f.events).toEqual(["generated", "validated", "validated", "proposed", "retired"])
  expect(await readdir(f.root)).not.toContain("Preferences")
})

test("no supported changes completes after joining the original lease without proposals", async () => {
  const f = await fixture()
  f.ports.admit = async () => ({
    generate: async () => [],
    retire: async () => {
      f.events.push("retired")
    },
  })
  const run = await MemoryFiles.dreamJob.start(f.root, f.project, f.selection, f.ports)
  expect(run.phase).toBe("completed")
  expect(run.reason).toBe("No supported memory changes")
  expect(f.events).toEqual(["retired"])
  expect((await MemoryFiles.dream.list(f.root, f.project)).rows).toEqual([])
  expect((await readdir(f.root)).filter((file) => file.endsWith(".proposal.json"))).toEqual([])
  const next = await MemoryFiles.dreamJob.start(f.root, f.project, { ...f.selection, id: randomUUID() }, f.ports)
  expect(next.phase).toBe("completed")
})

test("an orphan uncertain proposal blocks a new generation even without an active run", async () => {
  const f = await fixture()
  const [fingerprint] = await MemoryFiles.dream.stage(f.root, f.project, [f.candidate])
  await MemoryFiles.dream.submit(f.root, f.project, fingerprint, randomUUID())
  await expect(MemoryFiles.dreamJob.start(f.root, f.project, f.selection, f.ports)).rejects.toThrow(
    "original uncertain",
  )
  expect(f.events).toEqual([])
  expect((await MemoryFiles.dream.list(f.root, f.project)).runs).toEqual([])
})

test("empty output cannot claim completion when original lease retirement fails", async () => {
  const f = await fixture()
  f.ports.admit = async () => ({
    generate: async () => [],
    retire: async () => {
      throw new Error("Original lease unresolved")
    },
  })
  await expect(MemoryFiles.dreamJob.start(f.root, f.project, f.selection, f.ports)).rejects.toThrow("lease unresolved")
  expect((await MemoryFiles.dream.list(f.root, f.project)).runs[0].phase).toBe("reconciliation")
  await expect(
    MemoryFiles.dreamJob.start(f.root, f.project, { ...f.selection, id: randomUUID() }, f.ports),
  ).rejects.toThrow("original active")
})

test("lost proposal reply retains reconciliation and refuses another job", async () => {
  const f = await fixture()
  const propose = f.ports.propose.bind(f.ports)
  f.ports.propose = async (...args) => {
    await propose(...args)
    throw new Error("Reply lost after creation")
  }
  await expect(MemoryFiles.dreamJob.start(f.root, f.project, f.selection, f.ports)).rejects.toThrow("Reply lost")
  const ledger = await MemoryFiles.dream.list(f.root, f.project)
  expect(ledger.runs[0].phase).toBe("reconciliation")
  expect(ledger.rows[0].state).toBe("submitting")
  expect(await readFile(path.join(f.root, `${ledger.rows[0].proposal}.proposal.json`), "utf8")).toBeTruthy()
  await expect(
    MemoryFiles.dreamJob.start(f.root, f.project, { ...f.selection, id: randomUUID() }, f.ports),
  ).rejects.toThrow("original active")
  expect(f.events.filter((item) => item === "proposed")).toHaveLength(1)
})

test("cancel waits for the original generation to settle before retiring its lease", async () => {
  const f = await fixture()
  const controller = new AbortController()
  f.ports.admit = async () => ({
    generate: async (signal) => {
      controller.abort(new Error("User cancelled"))
      await Bun.sleep(20)
      f.events.push("generation-joined")
      signal.throwIfAborted()
      return [f.candidate]
    },
    retire: async () => {
      f.events.push("retired")
    },
  })
  await expect(MemoryFiles.dreamJob.start(f.root, f.project, f.selection, f.ports, controller.signal)).rejects.toThrow(
    "User cancelled",
  )
  expect(f.events).toEqual(["generation-joined", "retired"])
  const ledger = await MemoryFiles.dream.list(f.root, f.project)
  expect(ledger.runs[0].phase).toBe("cancelled")
  expect(ledger.rows).toEqual([])
})

test("stale evidence and secrets fail validation before any proposal is created", async () => {
  for (const kind of ["stale", "secret"]) {
    const f = await fixture()
    f.ports.admit = async () => ({
      generate: async () => {
        if (kind === "stale") await writeFile(f.file, "Changed evidence")
        return [{ ...f.candidate, rationale: kind === "secret" ? "password=hunterx" : f.candidate.rationale }]
      },
      retire: async () => {
        f.events.push("retired")
      },
    })
    await expect(MemoryFiles.dreamJob.start(f.root, f.project, f.selection, f.ports)).rejects.toThrow()
    expect((await MemoryFiles.dream.list(f.root, f.project)).runs[0].phase).toBe("failed")
    expect((await readdir(f.root)).filter((file) => file.endsWith(".proposal.json"))).toEqual([])
    expect(f.events).toEqual(["retired"])
  }
})

test("unconfirmed lease retirement preserves active reconciliation", async () => {
  const f = await fixture()
  f.ports.admit = async () => ({
    generate: async () => [f.candidate],
    retire: async () => {
      throw new Error("Lease not joined")
    },
  })
  await expect(MemoryFiles.dreamJob.start(f.root, f.project, f.selection, f.ports)).rejects.toThrow("Lease not joined")
  expect((await MemoryFiles.dream.list(f.root, f.project)).runs[0].phase).toBe("reconciliation")
})

test("generated output cannot exceed the explicit engineering budget", async () => {
  const f = await fixture()
  await expect(
    MemoryFiles.dreamJob.start(f.root, f.project, { ...f.selection, budget: { input: 3000, output: 1 } }, f.ports),
  ).rejects.toThrow("token budget")
  expect(f.events).toEqual(["generated", "retired"])
  expect((await MemoryFiles.dream.list(f.root, f.project)).rows).toEqual([])
})

test("model admission uses the retained run selection instead of mutable caller settings", async () => {
  const f = await fixture()
  const admit = f.ports.admit.bind(f.ports)
  f.ports.admit = async (selected, signal) => {
    f.selection.model = "changed/model"
    f.selection.budget.output = 1
    expect(selected.model).toBe("controlled-file-fixture")
    expect(selected.budget.output).toBe(1000)
    expect(selected.timeout).toBeLessThanOrEqual(300000)
    return admit(selected, signal)
  }
  const run = await MemoryFiles.dreamJob.start(f.root, f.project, f.selection, f.ports)
  expect(run.phase).toBe("review-pending")
  expect(run.model).toBe("controlled-file-fixture")
  expect(run.budget.output).toBe(1000)
})
