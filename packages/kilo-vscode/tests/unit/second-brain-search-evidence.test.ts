import { expect, test } from "bun:test"
import { search } from "../../src/second-brain/search-results"

const root = "c:/notes"
const footer =
  "Recorded update: 2026-10-08T05:16:42.304127+00:00. Source snapshots: [user_statement](<D:/Notes/System/Changes/e90ff591-4346-476b-a01a-0bfb42c6a676/source-0.txt>), [document](<D:/Notes/System/Changes/e90ff591-4346-476b-a01a-0bfb42c6a676/source-1.txt>)."

function row(text: string) {
  return {
    path: "C:/Notes/Preferences.md",
    relative: "Preferences.md",
    line: 3,
    end_line: 3,
    heading: "Preferences",
    text,
    source_sha256: "a".repeat(64),
    embedding_similarity: 0.8,
    relevance_score: 0.9,
  }
}

test("generated audit-only footers cannot become factual search candidates", () => {
  for (const ending of ["\n", "\r\n"]) {
    const text = ["Source: Preferences.md", "Section: Preferences", footer].join(ending)
    expect(search({ capture_enabled: false, results: [row(text)] }, root, 5)).toEqual([])
  }
  const text = "Use Onyx as the fallback.\n" + footer
  expect(search({ capture_enabled: false, results: [row(text)] }, root, 5)[0].text).toBe(text)
  const mixed = footer + " The passport is in the drawer."
  expect(search({ capture_enabled: false, results: [row(mixed)] }, root, 5)).toHaveLength(1)
})

test("footer filtering never bypasses source provenance validation", () => {
  for (const item of [
    { ...row(footer), source_sha256: "wrong" },
    { ...row(footer), path: "C:/Other/Preferences.md" },
  ])
    expect(() => search({ capture_enabled: false, results: [item] }, root, 5)).toThrow()
})
