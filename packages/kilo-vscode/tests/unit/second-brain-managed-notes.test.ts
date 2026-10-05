import { expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { descriptor, notes } from "../../src/second-brain/managed/descriptor"
import { document } from "../../src/second-brain/control/frames"
import { interpreter, supervisor } from "../../src/second-brain/managed/catalog"

function selected(root: string, external: string) {
  const generations = { root: ["18446744073709551615", "9007199254740993", "1"], system: ["2", "3", "4"] }
  const space = {
    root: path.join(root, "receipts"),
    sid: "S-1-5-21-1-2-3-1001",
    generations: { root: generations.root, Runs: generations.root, Requests: generations.root },
  }
  return {
    format: "raya.memory.managed.launch",
    version: 1,
    root,
    python: { path: path.join(root, "python.exe"), bytes: 1, sha256: interpreter },
    supervisor: { path: path.join(root, "supervise.py"), bytes: 1, sha256: supervisor },
    plan: { path: path.join(root, "plan.json"), bytes: 1, sha256: "a".repeat(64) },
    namespaces: { memory: space, retrieval: space },
    notes: { root: external, system: path.join(external, "System"), generations },
  }
}
function plan(cfg: ReturnType<typeof descriptor>) {
  return {
    notes_selection: cfg.notes,
    env: { RAYA_MEMORY_NOTE_GENERATIONS: '{"root":[18446744073709551615,9007199254740993,1],"system":[2,3,4]}' },
  }
}

test("selected external notes bind real existing directories and lossless plan tokens", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raya-managed-notes-"))
  const root = path.join(dir, "capsule")
  const external = path.join(dir, "external")
  await mkdir(path.join(external, "System"), { recursive: true })
  try {
    const input = selected(root, external)
    const cfg = descriptor(input)
    input.notes.generations.root[0] = "1"
    expect(cfg.notes!.generations.root[0]).toBe("18446744073709551615")
    expect(Object.isFrozen(cfg.notes!.generations.root)).toBe(true)
    await notes(cfg, document(Buffer.from(JSON.stringify(plan(cfg)))).value as Record<string, unknown>, external)
    await writeFile(path.join(external, "System", "index.sqlite"), "synthetic index")
    await notes(cfg, plan(cfg), external)
    await expect(notes(cfg, plan(cfg), dir)).rejects.toThrow("witness differs")
    await expect(
      notes(cfg, { ...plan(cfg), notes_selection: { ...cfg.notes, system: dir } }, external),
    ).rejects.toThrow()
    await expect(
      notes(
        cfg,
        {
          ...plan(cfg),
          env: { RAYA_MEMORY_NOTE_GENERATIONS: '{"root":[18446744073709551614,9007199254740993,1],"system":[2,3,4]}' },
        },
        external,
      ),
    ).rejects.toThrow("generation differs")
    await rm(path.join(external, "System"), { recursive: true })
    await expect(notes(cfg, plan(cfg), external)).rejects.toThrow()
  } finally {
    await rm(dir, { recursive: true })
  }
})

test("notes witness exact shape rejects malformed and unsafe integers", () => {
  const input = selected("C:/capsule", "D:/notes")
  expect(() => descriptor({ ...input, notes: undefined })).toThrow()
  expect(() => descriptor({ ...input, notes: { ...input.notes, system: "D:/foreign" } })).toThrow()
  for (const value of [1, "01", "18446744073709551616", "-1", null]) {
    expect(() =>
      descriptor({
        ...input,
        notes: { ...input.notes, generations: { ...input.notes.generations, root: [value, "1", "1"] } },
      }),
    ).toThrow()
  }
  expect(() => descriptor({ ...input, notes: { ...input.notes, extra: true } })).toThrow()
})

test("absent notes witness retains contained legacy setup and refuses unselected external roots", async () => {
  const input = selected("C:/capsule", "D:/notes")
  const { notes: omitted, ...legacy } = input
  const cfg = descriptor(legacy)
  expect(omitted).toBeDefined()
  await notes(cfg, { env: {} }, "C:/capsule")
  await notes(cfg, { env: {} }, "C:/capsule/notes")
  await expect(notes(cfg, { env: {} }, "D:/notes")).rejects.toThrow("require selection")
  await expect(notes(cfg, { env: {}, notes_selection: input.notes }, "C:/capsule/notes")).rejects.toThrow("Unselected")
})
