import { expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { MemoryFiles } from "../src/storage/store"

test("manual authorization precedes ledger writes and revoked authority stops before model admission", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-dream-manual-"))
  const project = path.join(root, "project")
  await mkdir(project)
  const text = "Approved synthetic project summary."
  await writeFile(path.join(project, "approved.md"), text)
  const selected = {
    id: randomUUID(),
    owner: randomUUID(),
    model: "test/controlled",
    timeout: 30000,
    budget: { input: 3000, output: 1000 },
    approved: {
      scope: randomUUID(),
      sources: [
        {
          path: "approved.md",
          sha256: createHash("sha256").update(text).digest("hex"),
          kind: "approved-summary" as const,
        },
      ],
      targets: [{ key: "preference", path: "Preferences/style.md", expected: null }],
    },
  }
  const ports: Parameters<typeof MemoryFiles.dreamManual.start>[3] = {
    authorize: async () => {
      throw new Error("Root authority is absent")
    },
    model: {
      resolve: () => Effect.die(new Error("Model must not start")),
      run: async () => {
        throw new Error("Model must not generate")
      },
    },
    execute: (effect) => Effect.runPromise(effect),
    propose: async () => {
      throw new Error("Proposal must not submit")
    },
  }
  await expect(MemoryFiles.dreamManual.start(root, project, selected, ports)).rejects.toThrow("authority is absent")
  expect(await readdir(root)).toEqual(["project"])
  let calls = 0
  ports.authorize = async () => {
    if (++calls === 2) throw new Error("Authority revoked")
  }
  await expect(MemoryFiles.dreamManual.start(root, project, selected, ports)).rejects.toThrow("Authority revoked")
  expect(calls).toBe(2)
  const ledger = await MemoryFiles.dream.list(root, project)
  expect(ledger.runs[0].phase).toBe("failed")
  expect(ledger.rows).toEqual([])
})

test("manual deadline joins original authorization and pre-cancelled requests have no side effects", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-dream-manual-cancel-"))
  const selected = {
    id: randomUUID(),
    owner: randomUUID(),
    model: "test/controlled",
    timeout: 10,
    budget: { input: 3000, output: 1000 },
    approved: {
      scope: randomUUID(),
      sources: [{ path: "approved.md", sha256: "a".repeat(64), kind: "approved-summary" as const }],
      targets: [{ key: "preference", path: "Preferences/style.md", expected: null }],
    },
  }
  const events: string[] = []
  const ports: Parameters<typeof MemoryFiles.dreamManual.start>[3] = {
    authorize: async (_root, _project, _approved, signal) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve()
        signal.addEventListener("abort", () => resolve(), { once: true })
      })
      await Bun.sleep(20)
      events.push("authorization-joined")
    },
    model: {
      resolve: () => Effect.die(new Error("Model must not start")),
      run: async () => {
        throw new Error("Model must not generate")
      },
    },
    execute: (effect) => Effect.runPromise(effect),
    propose: async () => {
      throw new Error("Proposal must not submit")
    },
  }
  await expect(MemoryFiles.dreamManual.start(root, root, selected, ports)).rejects.toThrow("deadline elapsed")
  expect(events).toEqual(["authorization-joined"])
  expect(await readdir(root)).toEqual([])
  const controller = new AbortController()
  controller.abort(new Error("Manual request cancelled"))
  await expect(MemoryFiles.dreamManual.start(root, root, selected, ports, controller.signal)).rejects.toThrow(
    "request cancelled",
  )
  expect(events).toEqual(["authorization-joined"])
  expect(await readdir(root)).toEqual([])
})
