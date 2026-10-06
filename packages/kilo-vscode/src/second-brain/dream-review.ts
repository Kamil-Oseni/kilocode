import { MemoryFiles } from "@kilocode/kilo-memory/store"
import { isDeepStrictEqual } from "node:util"
import path from "node:path"
import type { BrainProposal, BrainReview } from "../shared/second-brain"

function ordered<T extends { path: string }>(rows: readonly T[]) {
  return [...rows].sort((one, two) => (one.path < two.path ? -1 : one.path > two.path ? 1 : 0))
}

/** Read only. A reused proposal ID must not attach an old explanation to different evidence or changes. */
export async function explanation(root: string, project: string, proposal: BrainProposal, signal: AbortSignal) {
  signal.throwIfAborted()
  if (proposal.project !== project) throw new Error("Dream review belongs to another project")
  const saved = await MemoryFiles.dream.list(root, project)
  signal.throwIfAborted()
  const row = saved.rows.find((item) => item.proposal === proposal.id)
  if (!row) return undefined
  const sources = row.candidate.sources.map((source) => ({
    path: path.join(project, source.path),
    sha256: source.sha256,
    kind: "document",
    event_time: null,
  }))
  if (
    !isDeepStrictEqual(ordered(sources), ordered(proposal.sources)) ||
    !isDeepStrictEqual(
      ordered(row.candidate.changes),
      ordered(
        proposal.changes.map((change) => ({ path: change.path, expected: change.expected, content: change.content })),
      ),
    )
  )
    return undefined
  return {
    id: proposal.id,
    digest: proposal.digest,
    fingerprint: row.fingerprint,
    kind: row.candidate.kind,
    rationale: row.candidate.rationale,
    contradictions: [...row.candidate.contradictions],
  } satisfies BrainReview
}
