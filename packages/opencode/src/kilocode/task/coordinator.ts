import { and, eq, sql } from "drizzle-orm"
import { Data, Effect } from "effect"
import type { Database } from "@opencode-ai/core/database/database"
import {
  RayaRoutineOrganizationCoordinatorTable as Coordinator,
  RayaRoutineOrganizationTable as Organization,
} from "@opencode-ai/core/kilocode/routine.sql"
import { MessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import type { MessageID, SessionID } from "@/session/schema"

export class Conflict extends Data.TaggedError("RayaTaskCoordinator.Conflict")<{ message: string }> {}

type Ledger = Pick<Database.Interface["db"], "select">

export function cost(db: Ledger, organizationID: string) {
  return db
    .select({
      cost: sql<number>`coalesce(sum(case when json_type(${MessageTable.data}, '$.cost') in ('integer', 'real') and json_extract(${MessageTable.data}, '$.cost') >= 0 then json_extract(${MessageTable.data}, '$.cost') else 0 end), 0)`,
    })
    .from(Coordinator)
    .innerJoin(MessageTable, eq(MessageTable.id, Coordinator.message_id))
    .where(and(eq(Coordinator.organization_id, organizationID), eq(Coordinator.state, "attributed")))
    .get()
    .pipe(
      Effect.map((row) => (typeof row?.cost === "number" && Number.isFinite(row.cost) && row.cost >= 0 ? row.cost : 0)),
    )
}

export function make(database: Database.Interface) {
  const db = database.db
  const bind = Effect.fn("RayaTaskCoordinator.bind")(function* (input: {
    messageID: MessageID
    sessionID: SessionID
    organizationID: string
    organizationRevision: number
  }) {
    return yield* db
      .transaction(
        (tx) =>
          Effect.gen(function* () {
            const prior = yield* tx
              .select()
              .from(Coordinator)
              .where(eq(Coordinator.message_id, input.messageID))
              .get()
              .pipe(Effect.orDie)
            if (prior && prior.session_id !== input.sessionID)
              return yield* new Conflict({ message: "The coordinator message belongs to a different session." })
            const session = yield* tx
              .select({ id: SessionTable.id, metadata: SessionTable.metadata })
              .from(SessionTable)
              .where(eq(SessionTable.id, input.sessionID))
              .get()
              .pipe(Effect.orDie)
            if (!session) return prior
            if (session.metadata?.rayaRoutine !== undefined) return
            const message = yield* tx
              .select({ data: MessageTable.data })
              .from(MessageTable)
              .where(and(eq(MessageTable.id, input.messageID), eq(MessageTable.session_id, input.sessionID)))
              .get()
              .pipe(Effect.orDie)
            if (!message) return prior
            if (message.data.role !== "assistant")
              return yield* new Conflict({ message: "Only an assistant message can own coordinator cost." })
            const organization = yield* tx
              .select({ revision: Organization.revision, archived: Organization.archived_at })
              .from(Organization)
              .where(eq(Organization.id, input.organizationID))
              .get()
              .pipe(Effect.orDie)
            if (!organization || organization.archived !== null || organization.revision !== input.organizationRevision)
              return yield* new Conflict({
                message: "The organization changed before coordinator cost was attributed.",
              })
            const now = Date.now()
            if (!prior) {
              return yield* tx
                .insert(Coordinator)
                .values({
                  message_id: input.messageID,
                  session_id: input.sessionID,
                  organization_id: input.organizationID,
                  organization_revision: input.organizationRevision,
                  state: "attributed",
                  time_created: now,
                  time_updated: now,
                })
                .returning()
                .get()
                .pipe(Effect.orDie)
            }
            if (prior.state === "ambiguous") return prior
            if (prior.organization_id === input.organizationID) {
              if ((prior.organization_revision ?? 0) >= input.organizationRevision) return prior
              return yield* tx
                .update(Coordinator)
                .set({ organization_revision: input.organizationRevision, time_updated: now })
                .where(eq(Coordinator.message_id, input.messageID))
                .returning()
                .get()
                .pipe(Effect.orDie)
            }
            return yield* tx
              .update(Coordinator)
              .set({ organization_id: null, organization_revision: null, state: "ambiguous", time_updated: now })
              .where(eq(Coordinator.message_id, input.messageID))
              .returning()
              .get()
              .pipe(Effect.orDie)
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.catchTag("SqlError", Effect.die))
  })
  return { bind, cost: (organizationID: string) => cost(db, organizationID).pipe(Effect.orDie) }
}
