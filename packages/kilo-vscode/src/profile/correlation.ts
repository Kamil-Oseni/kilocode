import type { ManagedSource } from "../services/cli-backend/managed-source"

/** Only the manager supplies its live owned source; an equal DTO cannot supply it. */
export function correlated(
  source: ManagedSource | undefined,
  value: Readonly<{ pid: number; birth: string; executable: string; digest: string }>,
) {
  if (!source || source.exited) return false
  const current = source.session.ticket.header
  return (
    value.pid === current.pid &&
    value.birth === current.birth &&
    value.executable === current.executable &&
    value.digest === current.digest
  )
}
