import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Memory } from "../src/memory"
import { MemoryRecall } from "../src/recall/recall"

test("recall distinguishes facts sharing a long key prefix and keeps their labels stable across selection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-recall-identity-"))
  try {
    await Memory.enable({ root })
    const prefix = "bedroom_lighting_evening_preference_"
    await Memory.remember({ root, key: `${prefix}reading`, text: "Reading uses warm amber." })
    await Memory.remember({ root, key: `${prefix}movies`, text: "Movies use dim purple." })
    const ids = (block: string) => [...block.matchAll(/^record id=(\S+)/gm)].map((match) => match[1])
    const first = await MemoryRecall.search({ root, mode: "typed", query: prefix, maxBytes: 6000 })
    expect(first?.hits).toHaveLength(2)
    const labels = ids(first!.block)
    expect(labels).toHaveLength(2)
    expect(new Set(labels).size).toBe(2)
    expect(ids((await MemoryRecall.search({ root, mode: "typed", query: prefix, maxBytes: 6000 }))!.block)).toEqual(
      labels,
    )
    const selected = await MemoryRecall.search({ root, mode: "typed", query: "reading", maxBytes: 6000 })
    expect(selected?.hits).toHaveLength(1)
    const index = first!.hits.findIndex((hit) => hit.text.includes("Reading uses"))
    expect(ids(selected!.block)).toEqual([labels[index]])
    await Memory.remember({ root, key: `${prefix}reading`, text: "Reading now uses soft white." })
    const changed = await MemoryRecall.search({ root, mode: "typed", query: "reading", maxBytes: 6000 })
    expect(changed?.hits).toHaveLength(1)
    expect(changed?.block).toContain("soft white")
    expect(ids(changed!.block)[0]).not.toBe(labels[index])
    expect(labels.every((id) => /^[\p{L}\p{N}_.-]+$/u.test(id) && id.length <= 120)).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
