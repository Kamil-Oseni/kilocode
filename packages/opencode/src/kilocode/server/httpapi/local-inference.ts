import path from "node:path"
import { Effect } from "effect"
import type { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"
import type { Snapshot } from "../../provider/inference-observation"

const directory = (value: string) => {
  const resolved = path.resolve(value)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

/** Read only current transport observations in the selected session's actual workspace. */
export const read = Effect.fn("LocalInference.read")(function* (
  sessions: Pick<Session.Interface, "get">,
  scope: { projectID: string; directory: string },
  sessionID: SessionID,
): Effect.fn.Return<Snapshot | undefined, Session.NotFound> {
  const current = yield* sessions.get(sessionID)
  if (
    current.id !== sessionID ||
    current.projectID !== scope.projectID ||
    directory(current.directory) !== directory(scope.directory)
  )
    return undefined
  const scheduler = yield* Effect.promise(() => import("../../provider/local-scheduler"))
  return scheduler.session(sessionID)
})
