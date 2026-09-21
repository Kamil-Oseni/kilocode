import { and, eq } from "drizzle-orm"
import { Data, Effect } from "effect"
import type { Database } from "@opencode-ai/core/database/database"
import {
  RayaRoutineDelegationTable as Delegation,
  RayaRoutineOrganizationMemberTable as Member,
  RayaRoutineOrganizationReservationTable as Reservation,
  RayaRoutineOrganizationTable as Organization,
} from "@opencode-ai/core/kilocode/routine.sql"
import { commitment, direct, standing } from "./commitment"

export class Conflict extends Data.TaggedError("RayaTaskReservation.Conflict")<{ message: string }> {}

export function make(database: Database.Interface) {
  const db = database.db
  const reserve = Effect.fn("RayaTaskReservation.reserve")(function* (input: {
    runID: string
    agentID: string
    organizationID: string
    organizationRevision: number
    budget: number
  }) {
    if (!Number.isFinite(input.budget) || input.budget <= 0 || input.budget > 1_000_000)
      return yield* new Conflict({ message: "This Routine has an invalid model-cost limit." })
    return yield* db
      .transaction(
        (tx) =>
          Effect.gen(function* () {
            const prior = yield* tx
              .select()
              .from(Reservation)
              .where(eq(Reservation.run_id, input.runID))
              .get()
              .pipe(Effect.orDie)
            if (prior) {
              if (
                prior.agent_id === input.agentID &&
                prior.organization_id === input.organizationID &&
                prior.organization_revision === input.organizationRevision &&
                prior.budget === input.budget
              )
                return prior
              return yield* new Conflict({ message: "This Routine run already has a different budget reservation." })
            }
            const organization = yield* tx
              .select()
              .from(Organization)
              .where(eq(Organization.id, input.organizationID))
              .get()
              .pipe(Effect.orDie)
            if (
              !organization ||
              organization.archived_at !== null ||
              organization.revision !== input.organizationRevision
            )
              return yield* new Conflict({
                message: "This organization changed before the Routine could reserve budget.",
              })
            const member = yield* tx
              .select({ agentID: Member.agent_id })
              .from(Member)
              .where(and(eq(Member.organization_id, input.organizationID), eq(Member.agent_id, input.agentID)))
              .get()
              .pipe(Effect.orDie)
            if (!member)
              return yield* new Conflict({ message: "This Routine is no longer a member of the organization." })
            if (organization.budget !== null) {
              const work = yield* tx
                .select()
                .from(Delegation)
                .where(eq(Delegation.organization_id, input.organizationID))
                .all()
                .pipe(Effect.orDie)
              const spent = yield* direct(tx, input.organizationID).pipe(Effect.orDie)
              const held = yield* standing(tx, input.organizationID).pipe(Effect.orDie)
              if (commitment(work) + spent + held.committed + input.budget > organization.budget)
                return yield* new Conflict({
                  message: "This Routine exceeds the organization's remaining model-cost budget.",
                })
            }
            const now = Date.now()
            const row = {
              run_id: input.runID,
              agent_id: input.agentID,
              organization_id: input.organizationID,
              organization_revision: input.organizationRevision,
              session_id: null,
              budget: input.budget,
              cost: null,
              state: "reserved" as const,
              time_created: now,
              time_updated: now,
            }
            yield* tx.insert(Reservation).values(row).run().pipe(Effect.orDie)
            return row
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.catchTag("SqlError", Effect.die))
  })
  const link = Effect.fn("RayaTaskReservation.link")(function* (runID: string, sessionID: string) {
    return yield* db.transaction(
      (tx) =>
        Effect.gen(function* () {
          const row = yield* tx.select().from(Reservation).where(eq(Reservation.run_id, runID)).get().pipe(Effect.orDie)
          if (!row) return
          if (row.session_id && row.session_id !== sessionID)
            return yield* new Conflict({ message: "This Routine reservation is linked to a different session." })
          if (row.state === "linked" && row.session_id === sessionID) return row
          if (row.state !== "reserved")
            return yield* new Conflict({ message: "This Routine reservation is no longer active." })
          yield* tx
            .update(Reservation)
            .set({ session_id: sessionID, state: "linked", time_updated: Date.now() })
            .where(and(eq(Reservation.run_id, runID), eq(Reservation.state, "reserved")))
            .run()
            .pipe(Effect.orDie)
          return yield* tx.select().from(Reservation).where(eq(Reservation.run_id, runID)).get().pipe(Effect.orDie)
        }),
      { behavior: "immediate" },
    )
  })
  const settle = Effect.fn("RayaTaskReservation.settle")(function* (runID: string, sessionID: string, cost: number) {
    if (!Number.isFinite(cost) || cost < 0)
      return yield* new Conflict({ message: "This Routine reservation has an invalid settlement cost." })
    return yield* db.transaction(
      (tx) =>
        Effect.gen(function* () {
          const row = yield* tx.select().from(Reservation).where(eq(Reservation.run_id, runID)).get().pipe(Effect.orDie)
          if (!row) return
          if (row.session_id !== sessionID)
            return yield* new Conflict({ message: "This Routine reservation does not belong to the settled session." })
          if (row.state === "settled") {
            if (row.cost === cost) return row
            return yield* new Conflict({ message: "This Routine reservation already has a different settlement." })
          }
          if (row.state !== "linked") return yield* new Conflict({ message: "This Routine reservation is not linked." })
          yield* tx
            .update(Reservation)
            .set({ cost, state: "settled", time_updated: Date.now() })
            .where(and(eq(Reservation.run_id, runID), eq(Reservation.state, "linked")))
            .run()
            .pipe(Effect.orDie)
          return yield* tx.select().from(Reservation).where(eq(Reservation.run_id, runID)).get().pipe(Effect.orDie)
        }),
      { behavior: "immediate" },
    )
  })
  const release = Effect.fn("RayaTaskReservation.release")(function* (runID: string) {
    yield* db
      .update(Reservation)
      .set({ state: "released", time_updated: Date.now() })
      .where(and(eq(Reservation.run_id, runID), eq(Reservation.state, "reserved")))
      .run()
      .pipe(Effect.orDie)
  })
  return { reserve, link, settle, release }
}
