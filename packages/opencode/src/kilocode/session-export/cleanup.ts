/** Failed owners remain discoverable; a later native close is never assumed. */
export function closeExportOwners<T extends { close(): void }>(owners: Map<string, T>) {
  const errors: Error[] = []
  for (const [id, owner] of owners) {
    try {
      owner.close()
      owners.delete(id)
    } catch (err) {
      errors.push(
        new Error(
          `Session export sequencer close failed for ${id}: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        ),
      )
    }
  }
  return errors
}

export function exportFailure(errors: readonly unknown[]) {
  return new AggregateError(
    errors,
    `Session export shutdown is not confirmed: ${errors.map((err) => (err instanceof Error ? err.message : String(err))).join("; ")}`,
  )
}
