import { Effect } from "effect"
import { and, eq, gt, or, sql } from "drizzle-orm"
import type { Database } from "@opencode-ai/core/database/database"
import type { EventV2 } from "@opencode-ai/core/event"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { MessageTable } from "@opencode-ai/core/session/sql"
import type { MessageID, SessionID } from "@/session/schema"

export class Conflict extends Error {}

/** Only the conditional insertion is transactional; later part writes keep their normal lifecycle. */
export function publish(input: {
  database: Database.Interface
  events: Pick<EventV2.Interface, "publish">
  info: SessionV1.User
  sessionID: SessionID
  messageID?: MessageID
  queuedAt: number
}) {
  return Effect.gen(function* () {
    if (
      !input.messageID ||
      input.info.role !== "user" ||
      input.info.id !== input.messageID ||
      input.info.sessionID !== input.sessionID ||
      !Number.isFinite(input.queuedAt)
    )
      return yield* Effect.die(new Error("The continuation prompt no longer matches its reserved identity."))
    const id = input.messageID
    return yield* input.events
      .publish(
        SessionV1.Event.MessageUpdated,
        { sessionID: input.info.sessionID, info: input.info },
        {
          prepare: () =>
            Effect.gen(function* () {
              const existing = yield* input.database.db
                .select({ id: MessageTable.id })
                .from(MessageTable)
                .where(
                  or(
                    eq(MessageTable.id, id),
                    and(
                      eq(MessageTable.session_id, input.info.sessionID),
                      sql`json_extract(${MessageTable.data}, '$.role') = 'user'`,
                      or(gt(MessageTable.id, id), gt(MessageTable.time_created, input.queuedAt)),
                    ),
                  ),
                )
                .get()
                .pipe(Effect.orDie)
              if (existing)
                return yield* Effect.die(
                  new Conflict("The continuation prompt is already saved or newer user input superseded it."),
                )
              return undefined
            }),
        },
      )
      .pipe(Effect.asVoid)
  })
}
