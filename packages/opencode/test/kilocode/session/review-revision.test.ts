import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { revision, verify } from "@/kilocode/session/review-revision"

describe("review revision preconditions", () => {
  const directory = path.resolve("review-workspace")
  const first = { file: "first.ts", patch: "@@ -1 +1 @@\n-old\n+new", status: "modified" }
  const second = { file: "second.ts", patch: "@@ -1 +1 @@\n-old\n+other", status: "modified" }
  const expected = { [first.file]: revision(first), [second.file]: revision(second) }

  test("accepts exactly the reviewed set and a correctly scoped absolute path", async () => {
    await Effect.runPromise(verify([first, second], expected, directory))
    await Effect.runPromise(
      verify([first, second], { [first.file]: revision(first) }, directory, [path.join(directory, first.file)]),
    )
  })

  test("rejects changed content at identical line positions", async () => {
    const current = { ...first, patch: "@@ -1 +1 @@\n-old\n+replacement" }
    const error = await Effect.runPromise(Effect.flip(verify([current, second], expected, directory)))
    expect(error._tag).toBe("ReviewConflict")
  })

  test("rejects new, removed, renamed, missing and ambiguously addressed files", async () => {
    const cases = [
      verify([first], expected, directory),
      verify([first, second], { [first.file]: revision(first) }, directory),
      verify([{ ...first, file: "renamed.ts" }, second], expected, directory),
      verify([first, second], {}, directory, ["missing.ts"]),
      verify([first, second], {}, directory, []),
      verify([first], { [first.file]: revision(first), [`./${first.file}`]: revision(first) }, directory),
      verify([first, { ...first, file: `./${first.file}` }], { [first.file]: revision(first) }, directory),
    ]
    for (const check of cases) expect((await Effect.runPromise(Effect.flip(check)))._tag).toBe("ReviewConflict")
  })

  test("returns exact absolute scope rather than a suffix that could select another file", async () => {
    const nested = { ...first, file: "nested/first.ts" }
    expect(
      await Effect.runPromise(verify([first, nested], { [first.file]: revision(first) }, directory, [first.file])),
    ).toEqual([path.join(directory, first.file)])
  })
})
