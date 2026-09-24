import { Effect } from "effect"
import type { SessionID } from "@/session/schema"
import type { Storage } from "@/storage/storage"
import type { Session } from "@/session/session"
import type { RayaGoal } from "@/kilocode/goal"
import { ChiefBranches } from "./branches"

export namespace ChiefNotes {
  export type Identity = {
    sessionID: SessionID
    goalCreatedAt: number
    requestID: string
    revision: string
  }

  export class Stale extends Error {
    constructor() {
      super("The Chief plan no longer matches this request.")
    }
  }

  export function read(
    input: Identity,
    deps: {
      storage: Storage.Interface
      goals: Pick<ReturnType<typeof RayaGoal.make>, "get">
      sessions: Pick<Session.Interface, "get">
      context: { directory: string; project: { id: string } }
    },
  ) {
    return Effect.gen(function* () {
      const parent = yield* deps.sessions.get(input.sessionID)
      if (
        parent.id !== input.sessionID ||
        parent.projectID !== deps.context.project.id ||
        parent.directory !== deps.context.directory
      )
        throw new Stale()
      const goal = yield* deps.goals.get(input.sessionID)
      const plan = yield* ChiefBranches.make(deps.storage).read(input.sessionID)
      if (
        !plan ||
        plan.version !== 2 ||
        plan.goalID !== input.sessionID ||
        plan.goalCreatedAt !== input.goalCreatedAt ||
        plan.requestID !== input.requestID ||
        plan.revision !== input.revision ||
        !ChiefBranches.matches(plan, goal)
      )
        throw new Stale()
      const notes = plan.notes ?? []
      if (notes.length > 24) throw new Stale()
      return {
        version: 1 as const,
        sessionID: input.sessionID,
        goalCreatedAt: plan.goalCreatedAt,
        requestID: plan.requestID,
        revision: plan.revision,
        notes: notes.map((note) => {
          const branch = plan.branches.find((item) => item.id === note.branchID)
          if (
            !branch ||
            branch.sessionID !== note.childSessionID ||
            branch.callID !== note.taskCallID ||
            branch.messageID !== note.childMessageID ||
            note.goalCreatedAt !== plan.goalCreatedAt ||
            note.requestID !== plan.requestID
          )
            throw new Stale()
          return {
            version: note.version,
            id: note.id,
            branchID: note.branchID,
            branchName: branch.name,
            childSessionID: note.childSessionID,
            text: note.text,
            at: note.at,
            state: note.state,
          }
        }),
      }
    })
  }
}
