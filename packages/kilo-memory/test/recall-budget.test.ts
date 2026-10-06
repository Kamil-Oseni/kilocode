import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Memory } from "../src/memory"
import { MemoryRecall } from "../src/recall/recall"

for (const mode of ["typed", "digest"] as const) {
  test(`${mode} recall reports only complete records delivered within the byte budget`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "raya-recall-budget-"))
    try {
      await Memory.enable({ root })
      if (mode === "typed") {
        await Memory.remember({
          root,
          key: "alpha",
          text: "Prefer warm morning light. Keep the ceiling off until waking.",
        })
        await Memory.remember({
          root,
          key: "beta",
          text: "Prefer cool evening light. Keep the ceiling off during sleep.",
        })
      }
      if (mode === "digest") {
        for (const [index, text] of ["Japanese 日本語の設定", "French préférences du soir"].entries())
          await Memory.recordSession({
            root,
            sessionID: `ses_budget_${index}`,
            topic: `Budget ${index}`,
            summary: `${text}. Synthetic conversation detail for a bounded source receipt.`,
            time: Date.UTC(2026, 0, index + 1),
          })
      }
      const query = mode === "typed" ? "alpha beta" : ""
      const full = await MemoryRecall.search({ root, mode, query, maxBytes: 6000 })
      expect(full?.hits).toHaveLength(2)
      const first = await MemoryRecall.search({ root, mode, query, limit: 1, maxBytes: 6000 })
      expect(first?.hits).toHaveLength(1)
      const max = first!.bytes + 1
      const limited = await MemoryRecall.search({ root, mode, query, maxBytes: max })
      expect(limited?.hits).toEqual(first!.hits)
      expect(limited!.bytes).toBe(Buffer.byteLength(limited!.block))
      expect(limited!.bytes).toBeLessThanOrEqual(max)
      expect(limited!.block).toContain(`text: ${first!.hits[0].text}`)
      expect(limited!.block).not.toContain(`text: ${full!.hits[1].text}`)
      expect(limited!.block.endsWith("```")).toBe(true)
      // A wrapper alone is not a delivered memory hit or a successful recall.
      expect(await MemoryRecall.search({ root, mode, query, maxBytes: 80 })).toBeUndefined()
      if (mode === "digest")
        expect(
          await MemoryRecall.search({ root, mode, query, sessionID: "ses_budget_0", maxBytes: 80 }),
        ).toBeUndefined()
      for (const budget of [0, 1, 80, first!.bytes - 1, first!.bytes, full!.bytes, full!.bytes + 1]) {
        const result = await MemoryRecall.search({ root, mode, query, maxBytes: budget })
        if (!result) continue
        expect(result.bytes).toBeLessThanOrEqual(budget)
        expect(result.block.match(/^record /gm)?.length).toBe(result.hits.length)
        expect(result.block.match(/^text: /gm)?.length).toBe(result.hits.length)
        for (const hit of result.hits) expect(result.block).toContain(`text: ${hit.text}`)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}
