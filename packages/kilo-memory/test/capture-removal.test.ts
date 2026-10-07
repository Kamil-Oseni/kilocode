import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Memory } from "../src/memory"
import { MemoryOperations } from "../src/capture/operations"
import { MemoryFiles } from "../src/storage/store"
import { MemoryShared } from "../src/recall/shared"
import { duplicateOps } from "../src/capture/outcome"

test("automatic removals preserve facts sharing a key across files and sections", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-memory-removal-"))
  try {
    await Memory.enable({ root })
    await MemoryOperations.apply({
      root,
      ops: [
        { action: "add", file: "project.md", section: "Facts", key: "schedule", text: "Eden launches on Friday." },
        {
          action: "add",
          file: "project.md",
          section: "Decisions",
          key: "schedule",
          text: "Review releases every Monday.",
        },
        {
          action: "add",
          file: "environment.md",
          section: "Commands",
          key: "schedule",
          text: "Backups run each night.",
        },
      ],
    })
    const inventory = await MemoryFiles.deriveInventory(root)
    const keys = Object.entries(inventory.items).flatMap(([id, item]) => [id, item.key])
    const ambiguous = MemoryOperations.reconcile({ keys, ops: [{ action: "remove", query: "schedule" }] })
    expect(ambiguous.removes).toEqual([])
    const exact = MemoryOperations.reconcile({ keys, ops: [{ action: "remove", query: "project.md:Facts:schedule" }] })
    await MemoryOperations.apply({ root, ops: exact.removes })
    const remaining = await MemoryFiles.deriveInventory(root)
    expect(Object.keys(remaining.items).sort()).toEqual([
      "environment.md:Commands:schedule",
      "project.md:Decisions:schedule",
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("automatic removal binds a unique alias to its stored identity before applying", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-memory-removal-"))
  try {
    await Memory.enable({ root })
    await MemoryOperations.apply({ root, ops: [{ action: "add", key: "schedule", text: "Eden launches on Friday." }] })
    const inventory = await MemoryFiles.deriveInventory(root)
    const keys = Object.entries(inventory.items).flatMap(([id, item]) => [id, item.key])
    const result = MemoryOperations.reconcile({ keys, ops: [{ action: "remove", query: "schedule" }] })
    expect(result.removes).toEqual([{ action: "remove", query: "project.md:Facts:schedule" }])
    await MemoryOperations.apply({
      root,
      ops: [
        {
          action: "add",
          file: "environment.md",
          section: "Commands",
          key: "schedule",
          text: "Backups run each night.",
        },
      ],
    })
    await MemoryOperations.apply({ root, ops: result.removes })
    expect(Object.keys((await MemoryFiles.deriveInventory(root)).items)).toEqual(["environment.md:Commands:schedule"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("automatic upserts supersede deletes using the same normalized default identity", () => {
  const result = MemoryOperations.reconcile({
    keys: ["project.md:Facts:wake_mode", "wake_mode"],
    ops: [
      { action: "add", key: " Wake Mode ", text: "Wake at nine each morning." },
      { action: "remove", query: "project.md:Facts:wake_mode" },
    ],
  })
  expect(result.removes).toEqual([])
  expect(result.ops).toHaveLength(1)
})

test("capture identifies upserts in headings with spaces using the actual stored identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-memory-removal-"))
  try {
    await Memory.enable({ root })
    const original = {
      action: "add" as const,
      file: "project.md" as const,
      section: "Release Notes",
      key: "launch",
      text: "Eden launches on Friday.",
    }
    await MemoryOperations.apply({ root, ops: [original] })
    const inventory = await MemoryFiles.deriveInventory(root)
    const text = await MemoryFiles.readSource(root, "project.md")
    const items = MemoryShared.source({ file: "project.md", text })
    expect(items[0]?.id).toBe(Object.keys(inventory.items)[0])
    expect(MemoryOperations.id(original)).toBe(items[0].id)
    const replacement = { ...original, text: "Eden launches on Saturday." }
    const generated = duplicateOps({ ops: [replacement], skipped: [], items })
    expect(generated.ops).toEqual([replacement])
    await MemoryOperations.apply({ root, ops: generated.ops })
    const updated = await MemoryFiles.deriveInventory(root)
    expect(Object.keys(updated.items)).toEqual(Object.keys(inventory.items))
    expect(Object.values(updated.items)[0]?.text).toBe(replacement.text)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
