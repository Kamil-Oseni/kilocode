type Run = {
  id: string
  revision?: number
  status: "running" | "complete" | "blocked" | "error"
  blockedReason?: string
}

const pending = (run: Run) =>
  run.status === "running" || (run.status === "blocked" && run.blockedReason === "waiting on you")

/** An older bulk read cannot replace a newer run received from the event snapshot. */
export function projectRuns<T extends Run>(prior: readonly T[], incoming: readonly T[], preserveMissing: boolean): T[] {
  const rows = new Map(incoming.map((run) => [run.id, run]))
  for (const run of prior) {
    const next = rows.get(run.id)
    if (!next) {
      if (preserveMissing) rows.set(run.id, run)
      continue
    }
    const previous = run.revision ?? 0
    const current = next.revision ?? 0
    if (previous > current || (previous === current && run.status !== "running" && next.status === "running"))
      rows.set(run.id, run)
  }
  const result = [...rows.values()]
  const retained = new Set(
    result
      .filter((run) => !pending(run))
      .slice(-50)
      .map((run) => run.id),
  )
  return result.filter((run) => pending(run) || retained.has(run.id))
}
