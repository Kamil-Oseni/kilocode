import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Memory } from "../src/memory"
import { MemoryFiles } from "../src/storage/store"
import { MemoryMarkdown } from "../src/storage/markdown"
import { MemoryRecall } from "../src/recall/recall"

for (const fence of ["```", "~~~~", "   ```", "````"]) {
  for (const action of ["recall", "remember", "forget"] as const) {
    test(`${action} ignores fenced memory examples (${JSON.stringify(fence)})`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "raya-memory-fences-"))
      try {
        await Memory.enable({ root })
        const sample = `${fence}md\n## Facts\n- preference :: Example purple light.\n${fence}`
        const nested = `${fence}md\n## Constraints\n- preference :: Example flashing light.\n${fence}`
        const text = `# Project Memory\n\n${sample}\n\n## Facts\n- preference :: Real warm light.\n${nested}\n- quiet :: Real quiet evenings.\n`
        await MemoryFiles.writeSource(root, "project.md", text)
        if (action === "recall") {
          const result = await MemoryRecall.search({ root, mode: "typed", query: "light", maxBytes: 6000 })
          expect(result?.hits).toHaveLength(1)
          expect(result?.block).toContain("Real warm light")
          expect(result?.block).not.toContain("Example")
          expect(await MemoryFiles.readSource(root, "project.md")).toBe(text)
        }
        if (action === "remember") await Memory.remember({ root, key: "preference", text: "Updated soft white light." })
        if (action === "forget") await Memory.forget({ root, query: "preference" })
        const saved = await MemoryFiles.readSource(root, "project.md")
        expect(saved).toContain(sample)
        expect(saved).toContain(nested)
        const rows = MemoryMarkdown.parse(saved)
        expect(rows.filter((row) => row.key === "preference")).toEqual(
          action === "forget"
            ? []
            : [
                {
                  section: "Facts",
                  key: "preference",
                  text: action === "remember" ? "Updated soft white light." : "Real warm light.",
                },
              ],
        )
        expect(rows.find((row) => row.key === "quiet")).toEqual({
          section: "Facts",
          key: "quiet",
          text: "Real quiet evenings.",
        })
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }
}

test("fenced examples end only at a matching sufficiently long plain closing fence", () => {
  const text = [
    "````md",
    "## Constraints",
    "- sample1 :: Example before a shorter fence.",
    "```",
    "- sample2 :: Example before a different fence.",
    "~~~~",
    "- sample3 :: Example before a closing fence with text.",
    "```` extra",
    "- sample4 :: Example before a longer valid closing fence.",
    "`````  \t",
    "## Facts",
    "- real :: Genuine saved fact.",
  ].join("\n")
  expect(MemoryMarkdown.parse(text)).toEqual([{ section: "Facts", key: "real", text: "Genuine saved fact." }])
  expect(MemoryMarkdown.parse(text.replaceAll("\n", "\r\n"))).toEqual(MemoryMarkdown.parse(text))
  // Backticks in an opening info string do not create a Markdown code fence.
  expect(MemoryMarkdown.parse("```invalid`info\n## Facts\n- real :: Genuine saved fact.\n")).toEqual([
    { section: "Facts", key: "real", text: "Genuine saved fact." },
  ])
})

test("remember refuses an unclosed fence before changing the saved source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-memory-unclosed-fence-"))
  try {
    await Memory.enable({ root })
    const text = "# Project Memory\n\n```md\n## Facts\n- sample :: Example only.\n"
    await MemoryFiles.writeSource(root, "project.md", text)
    await expect(Memory.remember({ root, key: "new", text: "A real saved fact." })).rejects.toThrow(
      "unclosed code fence",
    )
    expect(await MemoryFiles.readSource(root, "project.md")).toBe(text)
    expect(MemoryMarkdown.parse(text)).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
