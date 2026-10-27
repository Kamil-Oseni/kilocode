import { sameDirectory } from "../kilo-provider-utils"

/** A workspace hint carries no queue state and never adopts or tracks a session. */
export function invalidation(
  event: unknown,
  directory: string | undefined,
  scope: { connected: boolean; directory: string; routes: ReadonlyMap<string, string> },
) {
  if (!scope.connected || !directory || directory === "global") return
  if (!event || typeof event !== "object" || Array.isArray(event)) return
  const row = event as Record<string, unknown>
  if (row.type !== "session.inference.changed" || !row.properties || typeof row.properties !== "object") return
  const props = row.properties as Record<string, unknown>
  const id = props.sessionID
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(id)) return
  if (!sameDirectory(directory, scope.routes.get(id) ?? scope.directory)) return
  return id
}
