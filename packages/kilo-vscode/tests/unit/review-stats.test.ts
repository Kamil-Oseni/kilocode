// raya_change - chat review counts prefer session snapshots over workspace git
import { describe, expect, it } from "bun:test"
import path from "path"
import { apply, collect, fromMessages, fromParts, fromSummary, prefer, type ReviewCounts } from "../../webview-ui/src/components/chat/review-stats"

const root = path.join(__dirname, "../..")

describe("review stats", () => {
  it("prefers the richest non-empty session snapshot over git fallback", () => {
    expect(
      prefer(
        fromSummary({ files: 0, additions: 0, deletions: 0 }),
        fromSummary({
          files: 3,
          additions: 9,
          deletions: 0,
          diffs: [
            { file: "temp1.txt", additions: 3, deletions: 0 },
            { file: "temp2.txt", additions: 3, deletions: 0 },
            { file: "temp3.txt", additions: 3, deletions: 0 },
          ],
        }),
        { files: 0, additions: 0, deletions: 0 },
      ),
    ).toEqual({ files: 3, additions: 9, deletions: 0 })
  })

  it("counts files created through bash or PowerShell in this chat", () => {
    expect(
      fromParts([
        {
          type: "tool",
          tool: "bash",
          state: { input: { command: "Set-Content -Path 'C:\\dummy\\temp1.txt' -Value 'one'" } },
        },
        {
          type: "tool",
          tool: "shell",
          state: { input: { command: "Add-Content -Path 'C:\\dummy\\temp3.txt' -Value 'Hello World'" } },
        },
        { type: "tool", tool: "bash", state: { input: { command: "echo two > temp2.txt" } } },
      ]),
    ).toEqual({ files: 3, additions: 0, deletions: 0 })
  })

  it("counts write and edit tool parts from this chat and its children", () => {
    expect(
      fromParts([
        { type: "tool", tool: "write", state: { input: { filePath: "temp1.txt" } } },
        { type: "tool", tool: "write", state: { input: { filePath: "temp2.txt" } } },
        { type: "tool", tool: "edit", state: { metadata: { filediff: { file: "temp3.txt" } } } },
      ]),
    ).toEqual({ files: 3, additions: 0, deletions: 0 })
  })

  it("aggregates unique files from message diffs", () => {
    expect(
      fromMessages([
        {
          summary: {
            diffs: [
              { file: "temp1.txt", additions: 1, deletions: 0 },
              { file: "temp1.txt", additions: 1, deletions: 0 },
            ],
          },
        },
        { summary: { diffs: [{ file: "temp2.txt", additions: 2, deletions: 1 }] } },
      ]),
    ).toEqual({ files: 2, additions: 3, deletions: 1 })
  })

  it("collects child session snapshots and applies host review messages", () => {
    expect(
      collect({
        sid: "parent",
        sessions: {
          parent: { parentID: null, summary: { files: 0, additions: 0, deletions: 0 } },
          child: {
            parentID: "parent",
            summary: { files: 3, additions: 6, deletions: 0, diffs: [{ file: "temp1.txt", additions: 6, deletions: 0 }] },
          },
        },
        messages: [],
        git: { files: 0, additions: 0, deletions: 0 },
      }),
    ).toEqual({ files: 1, additions: 6, deletions: 0 })

    const worktree: ReviewCounts[] = []
    const live: ReviewCounts[] = []
    expect(
      apply({ type: "reviewStatsLoaded", sessionID: "parent", files: 3, additions: 9, deletions: 0 }, "parent", (value) => worktree.push(value), (value) => live.push(value)),
    ).toBe(true)
    expect(live[0]).toEqual({ files: 3, additions: 9, deletions: 0, sessionID: "parent" })
    expect(worktree).toEqual([])
  })

  it("keeps the Review changes label readable in a narrow sidebar", async () => {
    const css = await Bun.file(path.join(root, "webview-ui/src/styles/session-actions.css")).text()
    expect(css).toContain(".session-review-label")
    expect(css).toContain("white-space: nowrap")
    expect(css).toContain("min-width: max-content")
    expect(css).not.toContain("width: 26px")
    expect(css).toContain("flex-wrap: wrap")
  })
})
