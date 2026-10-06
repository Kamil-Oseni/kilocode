import { MemoryFiles } from "@kilocode/kilo-memory/store"

/** A saved checkpoint is not proof of a running worker or a verified repair. */
export async function snapshot(root: string, project: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const saved = await MemoryFiles.dream.list(root, project)
  signal.throwIfAborted()
  return JSON.stringify(
    {
      notice:
        "Read-only saved checkpoint. Run phases are persisted history, not live worker or GPU status. Proposed memories and repair lessons require separate review. This view cannot publish, retry, cancel, or enable capture.",
      capturedAt: new Date().toISOString(),
      project: saved.project,
      scope: saved.scope,
      slots: saved.slots,
      runs: saved.runs,
      proposals: saved.rows,
      deletedFacts: saved.tombstones,
    },
    null,
    2,
  )
}
