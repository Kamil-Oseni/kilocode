import { expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { runtime } from "./fixtures/native-memory-runtime"
import { protect } from "../../src/second-brain/control/protection"
import { object } from "../../src/second-brain/control/frames"
import { paired, selection } from "../../src/second-brain/managed/descriptor"

test("actual paired selection reads each inventory path and constructs each source target once, retaining row refusal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-memory-control-target-"))
  try {
    await protect(root)
    const notes = path.join(root, "notes")
    await mkdir(path.join(notes, "System"), { recursive: true })
    const current = await runtime(root, undefined, notes)
    const before = await selection(current.cfg, current.setup)
    if (!before.retrieval) throw new Error("Actual paired native fixture required")
    const targets = [before.plan, before.retrieval].flatMap((plan) =>
      Object.keys(object(plan.source_sha256)).map((name) => [String(plan.source), name]),
    )
    const held = spyOn(path, "join")
    try {
      const selected = await selection(current.cfg, current.setup)
      expect(selected.files.map((file) => file.digest)).toEqual(before.files.map((file) => file.digest))
      expect(targets.length).toBe(29)
      for (const target of targets)
        expect(
          held.mock.calls.filter((args) => args.length === 2 && args[0] === target[0] && args[1] === target[1]),
        ).toHaveLength(1)
    } finally {
      held.mockRestore()
    }
    const memory = structuredClone(before.plan)
    const retrieval = structuredClone(before.retrieval)
    if (!Array.isArray(memory.files)) throw new Error("Actual inventory required")
    const inventory: unknown[] = memory.files
    const reads = inventory.map(() => 0)
    const observed = inventory.map((value, index) => {
      const file = object(value)
      return {
        ...file,
        get path() {
          reads[index]++
          return file.path
        },
      }
    })
    paired(current.cfg, { ...memory, files: observed }, { ...retrieval, files: observed })
    expect(reads).toEqual(inventory.map(() => 1))
    const pin = path.join(String(memory.source), Object.keys(object(memory.source_sha256))[0])
    const position = inventory.findIndex((value) => object(value).path === pin)
    expect(position).toBeGreaterThanOrEqual(0)
    const file = inventory[position]
    for (const mode of ["missing", "duplicate", "malformed", "digest"] as const) {
      const files =
        mode === "missing"
          ? inventory.filter((_, index) => index !== position)
          : mode === "duplicate"
            ? [...inventory, file]
            : mode === "malformed"
              ? [...inventory, null]
              : inventory.map((value, index) =>
                  index === position ? { ...object(value), sha256: "0".repeat(64) } : value,
                )
      expect(() => paired(current.cfg, { ...memory, files }, { ...retrieval, files })).toThrow()
    }
  } finally {
    await rm(root, { recursive: true })
  }
}, 30000)
