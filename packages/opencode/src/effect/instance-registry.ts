import type { WorkspaceV2 } from "@opencode-ai/core/workspace" // kilocode_change

const disposers = new Set<(directory: string, workspaceID?: WorkspaceV2.ID) => Promise<void>>() // kilocode_change

// kilocode_change start
export function registerDisposer(
  disposer: (directory: string, workspaceID?: WorkspaceV2.ID) => Promise<void>, // kilocode_change
) {
  let live = true
  const entry: typeof disposer = (...args) => (live ? disposer(...args) : Promise.resolve())
  disposers.add(entry)
  return () => {
    live = false
    disposers.delete(entry)
  }
}

export async function disposeInstance(directory: string, workspaceID?: WorkspaceV2.ID) {
  const results = await Promise.allSettled(
    [...disposers].map((disposer) => Promise.resolve().then(() => disposer(directory, workspaceID))),
  )
  const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, "Instance cleanup failed")
}
// kilocode_change end
