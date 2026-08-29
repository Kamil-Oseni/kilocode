// raya_change - derive safe, individually reversible changes from a session diff
import type { AnnotationSide } from "@pierre/diffs"
import type { WorktreeFileDiff } from "../src/types/messages"

export interface ReviewHunk {
  id: string
  side: AnnotationSide
  line: number
  label: string
  expected: string
  content: string
  remove: boolean
}

const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm

export function withReviewCounts(diff: WorktreeFileDiff): WorktreeFileDiff {
  if (diff.additions > 0 || diff.deletions > 0 || !diff.patch) return diff
  const lines = diff.patch.split("\n")
  const additions = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length
  const deletions = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length
  return { ...diff, additions, deletions }
} // raya_change - recover accurate stats when snapshot metadata reports +0/-0

export function reviewHunks(diff: WorktreeFileDiff): ReviewHunk[] {
  if (!diff.patch || diff.kind === "image" || diff.summarized) return []
  const before = diff.before.split("\n")
  return [...diff.patch.matchAll(header)].map((match, index) => {
    const oldStart = Number(match[1])
    const oldCount = match[2] === undefined ? 1 : Number(match[2])
    const newStart = Number(match[3])
    const newCount = match[4] === undefined ? 1 : Number(match[4])
    const lines = diff.after.split("\n")
    const replacement = oldCount === 0 ? [] : before.slice(Math.max(0, oldStart - 1), oldStart - 1 + oldCount)
    lines.splice(Math.max(0, newStart - 1), newCount, ...replacement)
    const content = lines.join("\n")
    const additions = newCount === 0 ? "" : `+${newCount}`
    const deletions = oldCount === 0 ? "" : `-${oldCount}`
    return {
      id: `${diff.file}:${oldStart}:${oldCount}:${newStart}:${newCount}:${index}`,
      side: newCount > 0 ? "additions" : "deletions",
      line: Math.max(1, newCount > 0 ? newStart : oldStart),
      label: [additions, deletions].filter(Boolean).join(" "),
      expected: diff.after,
      content,
      remove: diff.status === "added" && content.length === 0,
    }
  })
}
