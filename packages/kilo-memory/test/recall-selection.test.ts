import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Memory } from "../src/memory"
import { MemoryRecall } from "../src/recall/recall"

for (const force of [false, true]) {
  for (const limit of [1, 2]) {
    test(`recall deduplicates before its ${limit}-hit limit (force=${force})`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "raya-recall-selection-"))
      try {
        await Memory.enable({ root })
        const text = "Release checklist requires reviewed artifacts before publishing."
        await Memory.remember({ root, key: "release_checklist", text })
        if (limit === 2) {
          // Keep corpus-wide noise filtering meaningful: three related entries
          // sit in a wider corpus, rather than making the topic ubiquitous.
          for (const [key, text] of [
            ["garden", "Garden soil and irrigation."],
            ["music", "Piano lessons on weekends."],
            ["books", "Read philosophy before bed."],
            ["travel", "Visit ocean beaches in summer."],
            ["food", "Prefer vegetarian meals for lunch."],
          ])
            await Memory.remember({ root, key, text })
          await Memory.recordSession({
            root,
            sessionID: "ses_new_detail",
            topic: "release checklist",
            summary: "Release checklist deadline is Friday; audit signing changes and notify the reviewer.",
            time: Date.now() - 100000,
          })
        }
        await Memory.recordSession({
          root,
          sessionID: "ses_restatement",
          topic: "release checklist",
          summary: text,
          // A recent restatement ranks before its canonical typed fact.
          time: Date.now() + 100000,
        })
        const full = await MemoryRecall.search({ root, query: "release checklist", force, limit: 20, maxBytes: 6000 })
        expect(full?.hits).toHaveLength(limit)
        expect(full?.hits.some((hit) => hit.type === "typed")).toBe(true)
        expect(full?.hits.some((hit) => hit.id === "ses_restatement")).toBe(false)
        const bounded = await MemoryRecall.search({ root, query: "release checklist", force, limit, maxBytes: 6000 })
        expect(bounded?.hits).toEqual(full!.hits)
        expect(bounded?.hits).toHaveLength(limit)
        if (limit === 2) expect(bounded?.block).toContain("ses_new_detail")
        expect(bounded?.block).not.toContain("ses_restatement")
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }
}
