// raya_change - /canvas must not degrade into a standalone HTML file
import { Effect } from "effect"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"

const PAGE = /\.html?$/i

export const rejectPage = (sessionID: SessionID, filepath: string) =>
  Effect.gen(function* () {
    if (!PAGE.test(filepath)) return
    const sessions = yield* Session.Service
    let current = yield* sessions.get(sessionID).pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)))
    while (current) {
      if (current.metadata?.["raya.canvas.command"] === true) {
        throw new Error(
          "This /canvas request must use create_canvas. Do not write a standalone .html/.htm file or open the browser.",
        )
      }
      if (!current.parentID) return
      current = yield* sessions
        .get(current.parentID)
        .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)))
    }
  })
