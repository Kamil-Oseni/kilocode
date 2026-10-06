import { expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { z } from "zod"
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

test("review during retirement closes only after the original lease successfully retires", async () => {
  for (const failed of [false, true]) {
    const f = await fixture()
    const work = MemoryFiles.dreamJob.start(f.root, f.project, f.selection, {
      ...f.ports,
      admit: async () => ({
        generate: async () => [f.candidate],
        retire: async () => {
          const saved = await MemoryFiles.dream.list(f.root, f.project)
          const row = saved.rows[0]
          await MemoryFiles.dream.settle(f.root, f.project, {
            fingerprint: row.fingerprint,
            proposal: row.proposal,
            state: "rejected",
            reason: "Explicit review during retirement",
          })
          if (failed) throw new Error("Original lease did not retire")
        },
      }),
    })
    if (failed) await expect(work).rejects.toThrow("did not retire")
    if (!failed) expect((await work).phase).toBe("completed")
    const saved = await MemoryFiles.dream.list(f.root, f.project)
    expect(saved.rows[0].state).toBe("rejected")
    expect(saved.runs[0].phase).toBe(failed ? "reconciliation" : "completed")
  }
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
  const phases: string[] = []
  await expect(
    MemoryFiles.dreamJob.start(f.root, f.project, f.selection, {
      ...f.ports,
      observe: (run) => phases.push(run.phase),
    }),
  ).rejects.toThrow("Lease not joined")
  expect((await MemoryFiles.dream.list(f.root, f.project)).runs[0].phase).toBe("reconciliation")
  expect(phases).toEqual(["generation", "validation", "submission", "reconciliation"])
})

test("phase observation retains the original saved run and cannot mutate generation authority", async () => {
  const f = await fixture()
  const phases: string[] = []
  const ids: string[] = []
  const saved: (string | undefined)[] = []
  const result = await MemoryFiles.dreamJob.start(f.root, f.project, f.selection, {
    ...f.ports,
    observe: (run) => {
      phases.push(run.phase)
      ids.push(run.id)
      const ledger = z
        .object({ runs: z.array(z.object({ id: z.string(), owner: z.string(), phase: z.string() })) })
        .parse(JSON.parse(readFileSync(path.join(f.root, "dream.json"), "utf8")))
      saved.push(ledger.runs.find((item) => item.id === run.id && item.owner === run.owner)?.phase)
      run.sources.length = 0
      run.budget.output = 1
    },
  })
  expect(phases).toEqual(["generation", "validation", "submission", "review-pending"])
  expect(ids).toEqual(phases.map(() => f.selection.id))
  expect(saved).toEqual(phases)
  expect(result.sources).toEqual(f.selection.sources)
  expect(result.budget).toEqual(f.selection.budget)
  expect((await MemoryFiles.dream.list(f.root, f.project)).runs[0]).toEqual(result)
})

test("display failure cannot fail an otherwise successful original run", async () => {
  const f = await fixture()
  let calls = 0
  const result = await MemoryFiles.dreamJob.start(f.root, f.project, f.selection, {
    ...f.ports,
    observe: () => {
      if (++calls === 1) throw new Error("Synthetic display unavailable")
    },
  })
  expect(result.phase).toBe("review-pending")
  expect(calls).toBe(4)
  expect(f.events.filter((event) => event === "proposed")).toHaveLength(1)
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
