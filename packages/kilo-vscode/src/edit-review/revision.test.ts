import { expect, test } from "bun:test"
import { fingerprint } from "./revision"
import { revision } from "../../../opencode/src/kilocode/session/review-revision"

test("extension review fingerprints match the backend wire contract", () => {
  for (const item of [
    { file: "file.ts", patch: "@@ -1 +1 @@\n-old\n+new", additions: 1, deletions: 1 },
    { file: "folder/é.txt", patch: "", before: "old\u0000text", after: "新しい", additions: 0, deletions: 0 },
    { file: "removed.ts", patch: "@@ -1 +0,0 @@\n-old", status: "deleted" as const, additions: 0, deletions: 1 },
    { file: "file.ts", patch: "same content", additions: 1, deletions: 1, generation: "message-a:part-a" },
  ])
    expect(fingerprint(item)).toBe(revision(item))
})

test("later patch events change identity without changing content", () => {
  const diff = { file: "file.ts", patch: "same content", additions: 1, deletions: 1 }
  expect(fingerprint({ ...diff, generation: "message-a:part-a" })).not.toBe(
    fingerprint({ ...diff, generation: "message-b:part-b" }),
  )
})
