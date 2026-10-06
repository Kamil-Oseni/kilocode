import type { MemoryFiles } from "@kilocode/kilo-memory/store"

type Saved = Awaited<ReturnType<typeof MemoryFiles.dream.list>>

/** Read-only guidance from saved history; none of these records certify present worker cleanup. */
export function triage(saved: Saved) {
  const named = saved.rows.filter((row) => row.proposal)
  const pending = named.filter((row) => row.state === "pending")
  const unknown = named.filter((row) => row.state === "submitting")
  const linked = new Set(saved.runs.flatMap((run) => run.candidates))
  return {
    scope: "Saved history only. Current proposal outcomes and original worker cleanup require separate inspection.",
    counts: { pendingReview: pending.length, unconfirmedCreation: unknown.length },
    originalProposals: named.map((row) => ({
      id: row.proposal,
      fingerprint: row.fingerprint,
      recordedState: row.state,
      linkedToRun: linked.has(row.fingerprint),
      next:
        row.state === "submitting"
          ? "Refresh proposals and read this original ID through the existing review owner. An absent or unavailable outcome remains unconfirmed; do not create a replacement."
          : row.state === "pending"
            ? "Refresh proposals and read this original ID before reviewing its current revision. Applying or rejecting remains a separate action."
            : row.state === "prepared"
              ? "This prepared record includes an original proposal ID. Inspect that original outcome and selection before any submission; do not create a replacement."
              : "This is a recorded review disposition. Read its original outcome and current note revision before further action; saved history is not current publication or index-freshness proof.",
    })),
    originalRuns: saved.runs.map((run) => {
      const rows = saved.rows.filter((row) => run.candidates.includes(row.fingerprint))
      const inspect = ["generation", "validation", "submission", "reconciliation"].includes(run.phase)
      return {
        id: run.id,
        owner: run.owner,
        model: run.model,
        recordedPhase: run.phase,
        recordedReason: run.reason,
        originalProposalIds: rows.flatMap((row) => (row.proposal ? [row.proposal] : [])),
        next: inspect
          ? "Inspect this original run and owner on its original backend and lifecycle owner. SDK settlement alone does not certify native/GPU retirement. Preserve unavailable or unresolved outcomes; do not replay generation or submission."
          : rows.some((row) => row.state === "pending")
            ? "The original run has saved pending proposals, including any preserved after cancellation. Review their current original outcomes separately. This checkpoint does not apply them."
            : "The recorded phase is historical. This checkpoint does not establish current worker status, note contents or search-index freshness, and cannot authorize a replacement run.",
      }
    }),
    unsubmitted: saved.rows
      .filter((row) => row.state === "prepared" && !row.proposal)
      .map((row) => ({
        fingerprint: row.fingerprint,
        next: "No proposal ID is recorded for this prepared candidate. Inspect its original selection and owner before any submission; this view cannot create it.",
      })),
  }
}
