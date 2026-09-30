type Run = { id: string; revision?: number; status: "running" | "complete" | "blocked" | "error" }

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
  return [...rows.values()].slice(-50)
}
