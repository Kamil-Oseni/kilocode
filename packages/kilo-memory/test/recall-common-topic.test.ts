import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Memory } from "../src/memory"
import { MemoryRecall } from "../src/recall/recall"

for (const force of [false, true]) {
  for (const query of ["release checklist", "Tell me about our release checklist"]) {
    test(`recall finds a common saved topic when filtered terms yield nothing (${query}, force=${force})`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "raya-recall-common-topic-"))
      try {
        await Memory.enable({ root })
        for (const [key, text] of [
          ["review", "Release checklist requires reviewed artifacts."],
          ["signing", "Release checklist requires signed packages."],
          ["recovery", "Release checklist requires rollback verification."],
        ])
          await Memory.remember({ root, key, text })
        const result = await MemoryRecall.search({ root, query, force, maxBytes: 6000 })
        expect(result?.hits).toHaveLength(3)
        for (const text of ["reviewed artifacts", "signed packages", "rollback verification"])
          expect(result?.block).toContain(text)
        // Recovery must not manufacture a match for an absent topic.
        expect(await MemoryRecall.search({ root, query: "gardening irrigation", force })).toBeUndefined()
        // A discriminative query still keeps the original selection behavior.
        const selected = await MemoryRecall.search({ root, query: "release checklist signing", force, maxBytes: 6000 })
        expect(selected?.hits).toHaveLength(1)
        expect(selected?.block).toContain("signed packages")
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }
}
