import { and, eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "@opencode-ai/core/database/database"
import { RayaRoutineOrganizationReservationTable as Reservation } from "@opencode-ai/core/kilocode/routine.sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { isRecord } from "@/util/record"

type Row = {
  id: string
  parent_id: string | null
  state: string
  budget: number | null
  cost: number | null
  session_id: string | null
}

const live = new Set(["queued", "accepted", "running", "needs_input"])

export function commitment(rows: readonly Row[]) {
  const index = new Map(rows.map((row) => [row.id, row]))
  const children = new Map<string, Row[]>()
  for (const row of rows) {
    if (!row.parent_id || !index.has(row.parent_id)) continue
    children.set(row.parent_id, [...(children.get(row.parent_id) ?? []), row])
  }
  const seen = new Set<string>()
  const reserve = (row: Row): number => {
    if (seen.has(row.id)) return 0
    seen.add(row.id)
    const child = (children.get(row.id) ?? []).reduce((total, item) => total + reserve(item), 0)
    if (live.has(row.state)) return Math.max(row.budget ?? 0, child)
    if (row.cost === null) return row.session_id ? Math.max(row.budget ?? 0, child) : child
    return row.cost + child
  }
  const roots = rows.filter((row) => !row.parent_id || !index.has(row.parent_id))
  const rooted = roots.reduce((total, row) => total + reserve(row), 0)
  return rows.reduce((total, row) => total + (seen.has(row.id) ? 0 : reserve(row)), rooted)
}

type Ledger = Pick<Database.Interface["db"], "select">

/** An authenticated standing run reserves its direct work and delegation subtree together. */
export function coverage(
  db: Ledger,
  organizationID: string,
  rows: readonly (Row & { parent_run_id: string | null; sender_id: string; organization_id: string | null })[],
) {
  return Effect.gen(function* () {
    const held = yield* standing(db, organizationID)
    const reservations = yield* db
      .select({ reservation: Reservation, session: SessionTable })
      .from(Reservation)
      .leftJoin(SessionTable, eq(SessionTable.id, Reservation.session_id))
      .where(eq(Reservation.organization_id, organizationID))
      .all()
    const covered = new Set<string>()
    const edges = new Map<string, string[]>()
    for (const row of rows) {
      if (!row.parent_id) continue
      edges.set(row.parent_id, [...(edges.get(row.parent_id) ?? []), row.id])
    }
    const totals = { committed: held.committed }
    for (const { reservation, session } of reservations) {
      const owner = session?.metadata?.rayaRoutine
      if (
        reservation.state !== "linked" ||
        !session ||
        session.id !== reservation.session_id ||
        session.time_archived !== null ||
        !isRecord(owner) ||
        owner.runID !== reservation.run_id ||
        owner.agentID !== reservation.agent_id ||
        owner.organizationID !== organizationID ||
        owner.organizationRevision !== reservation.organization_revision ||
        owner.budget !== reservation.budget ||
        owner.delegationID !== undefined ||
        !Number.isFinite(session.cost) ||
        session.cost < 0
      )
        continue
      const selected = new Set(
        rows
          .filter(
            (row) =>
              row.parent_id === null &&
              row.parent_run_id === reservation.run_id &&
              row.sender_id === reservation.agent_id &&
              row.organization_id === organizationID,
          )
          .map((row) => row.id),
      )
      const pending = [...selected]
      while (pending.length) {
        const parent = pending.pop()!
        for (const id of edges.get(parent) ?? []) {
          if (selected.has(id)) continue
          selected.add(id)
          pending.push(id)
        }
      }
      if ([...selected].some((id) => covered.has(id))) continue
      const children = commitment(rows.filter((row) => selected.has(row.id)))
      totals.committed += Math.max(reservation.budget, session.cost + children) - reservation.budget
      for (const id of selected) covered.add(id)
    }
    return {
      recorded: held.recorded,
      committed: totals.committed + commitment(rows.filter((row) => !covered.has(row.id))),
    }
  })
}

export function direct(db: Ledger, organizationID: string) {
  return db
    .select({
      cost: sql<number>`coalesce(sum(${SessionTable.cost}), 0)`,
    })
    .from(SessionTable)
    .where(
      and(
        sql`json_extract(${SessionTable.metadata}, '$.rayaRoutine.organizationID') = ${organizationID}`,
        sql`json_extract(${SessionTable.metadata}, '$.rayaRoutine.delegationID') is null`,
        sql`not exists (select 1 from raya_routine_organization_reservation as reservation where reservation.session_id = ${SessionTable.id})`,
      ),
    )
    .get()
    .pipe(
      Effect.map((row) => (typeof row?.cost === "number" && Number.isFinite(row.cost) && row.cost >= 0 ? row.cost : 0)),
    )
}

export function standing(db: Ledger, organizationID: string) {
  return db
    .select({ state: Reservation.state, budget: Reservation.budget, cost: Reservation.cost })
    .from(Reservation)
    .where(eq(Reservation.organization_id, organizationID))
    .all()
    .pipe(
      Effect.map((rows) =>
        rows.reduce(
          (total, row) => {
            if (row.state === "reserved" || row.state === "linked") total.committed += row.budget
            if (row.state === "settled") {
              const cost =
                typeof row.cost === "number" && Number.isFinite(row.cost) && row.cost >= 0 ? row.cost : row.budget
              total.recorded += cost
              total.committed += cost
            }
            return total
          },
          { recorded: 0, committed: 0 },
        ),
      ),
    )
}
