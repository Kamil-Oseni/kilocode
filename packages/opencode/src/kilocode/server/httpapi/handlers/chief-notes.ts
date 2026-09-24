import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ChiefNotes } from "@/kilocode/chief/notes"
import { RayaGoal } from "@/kilocode/goal"
import { Session } from "@/session/session"
import { Storage } from "@/storage/storage"
import { InstanceState } from "@/effect/instance-state"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { notFound } from "@/server/routes/instance/httpapi/errors"
import type { ChiefNotesQuery } from "../groups/chief-notes"
import type { SessionID } from "@/session/schema"

export const chiefNotesHandlers = HttpApiBuilder.group(InstanceHttpApi, "chief-notes", (handlers) =>
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const sessions = yield* Session.Service
    const goals = RayaGoal.make({ storage, sessions })
    return handlers.handle("list", (ctx: { params: { sessionID: SessionID }; query: typeof ChiefNotesQuery.Type }) =>
      Effect.flatMap(InstanceState.context, (context) =>
        ChiefNotes.read(
          {
            sessionID: ctx.params.sessionID,
            goalCreatedAt: ctx.query.goalCreatedAt,
            requestID: ctx.query.requestID,
            revision: ctx.query.revision,
          },
          { storage, goals, sessions, context },
        ),
      ).pipe(Effect.catch(() => notFound("Chief plan not found or no longer active."))),
    )
  }),
)
