// raya_change - verify exact per-hunk rollback content for the inline review surface
import { describe, expect, test } from "bun:test"
import { reviewHunks, withReviewCounts } from "../../webview-ui/diff-viewer/review-hunks"

describe("inline change review", () => {
  test("reverts one modified hunk without touching another", () => {
    const before = "alpha\nold one\nmiddle\nold two\nomega\n"
    const after = "alpha\nnew one\nmiddle\nnew two\nomega\n"
    const patch =
      "@@ -1,3 +1,3 @@\n alpha\n-old one\n+new one\n middle\n@@ -3,3 +3,3 @@\n middle\n-old two\n+new two\n omega\n"
    const hunks = reviewHunks({
      file: "sample.txt",
      before,
      after,
      patch,
      additions: 2,
      deletions: 2,
      status: "modified",
    })

    expect(hunks).toHaveLength(2)
    expect(hunks[0]?.content).toBe("alpha\nold one\nmiddle\nnew two\nomega\n")
    expect(hunks[1]?.content).toBe("alpha\nnew one\nmiddle\nold two\nomega\n")
  })

  test("deletes a file created entirely by the selected hunk", () => {
    const hunks = reviewHunks({
      file: "new.txt",
      before: "",
      after: "hello\n",
      patch: "@@ -0,0 +1 @@\n+hello\n",
      additions: 1,
      deletions: 0,
      status: "added",
    })

    expect(hunks).toHaveLength(1)
    expect(hunks[0]).toMatchObject({ content: "", remove: true, side: "additions" })
  })

  test("restores a deleted block", () => {
    const hunks = reviewHunks({
      file: "existing.txt",
      before: "keep\nrestore me\nend\n",
      after: "keep\nend\n",
      patch: "@@ -1,3 +1,2 @@\n keep\n-restore me\n end\n",
      additions: 0,
      deletions: 1,
      status: "modified",
    })

    expect(hunks[0]).toMatchObject({
      content: "keep\nrestore me\nend\n",
      remove: false,
      side: "additions",
    })
  })

  test("recovers visible counts when snapshot metadata reports zero", () => {
    expect(
      withReviewCounts({
        file: "sample.txt",
        before: "old\n",
        after: "new\nmore\n",
        patch: "@@ -1 +1,2 @@\n-old\n+new\n+more\n",
        additions: 0,
        deletions: 0,
        status: "modified",
      }),
    ).toMatchObject({ additions: 2, deletions: 1 })
  })
})
