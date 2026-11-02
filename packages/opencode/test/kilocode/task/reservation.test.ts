import { expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import {
  RayaRoutineOrganizationCoordinatorTable as Coordinator,
  RayaRoutineDelegationTable as Delegation,
  RayaRoutineOrganizationReservationTable as Reservation,
  RayaRoutineOrganizationMemberTable as Member,
  RayaRoutineOrganizationTable as Organization,
} from "@opencode-ai/core/kilocode/routine.sql"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { MessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { MessageID, SessionID } from "@/session/schema"
import { direct, standing } from "@/kilocode/task/commitment"
import { make } from "@/kilocode/task/reservation"
import { RayaTaskDelegation } from "@/kilocode/task/delegation"
import { RayaTaskInfo } from "@/kilocode/task/info"
import type { RayaTask } from "@/kilocode/task"

test("standalone Routine reservations serialize, settle exact cost, and never double count their session", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const id = "org_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      yield* database.db.insert(Organization).values({
        id,
        name: "Bounded company",
        purpose: null,
        policy: null,
        budget: 10,
        revision: 1,
        archived_at: null,
        time_created: 1,
        time_updated: 1,
      })
      yield* database.db.insert(Member).values([
        { organization_id: id, agent_id: "worker_one", role: "worker", position: 0, time_created: 1, time_updated: 1 },
        { organization_id: id, agent_id: "worker_two", role: "worker", position: 1, time_created: 1, time_updated: 1 },
        {
          organization_id: id,
          agent_id: "worker_three",
          role: "worker",
          position: 2,
          time_created: 1,
          time_updated: 1,
        },
      ])
      const project = ProjectV2.ID.make("project_standalone_reservation")
      const coordinator = SessionID.make("ses_reservation_coordinator")
      yield* database.db.insert(ProjectTable).values({
        id: project,
        worktree: AbsolutePath.make("/workspace"),
        sandboxes: [],
        time_created: 1,
        time_updated: 1,
      })
      yield* database.db.insert(SessionTable).values({
        id: coordinator,
        project_id: project,
        slug: "reservation-coordinator",
        directory: AbsolutePath.make("/workspace"),
        title: "Reservation coordinator",
        version: "test",
        cost: 4,
        time_created: 1,
        time_updated: 1,
      })
      yield* database.db.insert(MessageTable).values({
        id: MessageID.make("msg_reservation_coordinator"),
        session_id: coordinator,
        time_created: 1,
        data: { role: "assistant", cost: 4 } as never,
      })
      yield* database.db.insert(Coordinator).values({
        message_id: "msg_reservation_coordinator",
        session_id: coordinator,
        organization_id: id,
        organization_revision: 1,
        state: "attributed",
        time_created: 1,
        time_updated: 1,
      })
      const reservations = make(database)
      const raced = yield* Effect.all(
        [
          reservations
            .reserve({
              runID: "run_one",
              agentID: "worker_one",
              organizationID: id,
              organizationRevision: 1,
              budget: 5,
            })
            .pipe(Effect.exit),
          reservations
            .reserve({
              runID: "run_two",
              agentID: "worker_two",
              organizationID: id,
              organizationRevision: 1,
              budget: 5,
            })
            .pipe(Effect.exit),
        ],
        { concurrency: "unbounded" },
      )
      expect(raced.filter(Exit.isSuccess)).toHaveLength(1)
      expect(raced.filter(Exit.isFailure)).toHaveLength(1)
      const run = raced.find(Exit.isSuccess)!.value.run_id
      const session = SessionID.make("ses_standalone_reservation")
      yield* reservations.link(run, session)
      yield* database.db.insert(SessionTable).values({
        id: session,
        project_id: project,
        slug: "standalone-reservation",
        directory: AbsolutePath.make("/workspace"),
        title: "Standalone reservation",
        version: "test",
        cost: 2,
        metadata: { rayaRoutine: { organizationID: id, runID: run } },
        time_created: 1,
        time_updated: 1,
      })
      expect(yield* direct(database.db, id)).toBe(0)
      expect(yield* standing(database.db, id)).toEqual({ recorded: 0, committed: 5 })
      yield* reservations.settle(run, session, 2)
      expect(yield* direct(database.db, id)).toBe(0)
      expect(yield* standing(database.db, id)).toEqual({ recorded: 2, committed: 2 })
      const exact = yield* reservations.reserve({
        runID: "run_exact",
        agentID: "worker_three",
        organizationID: id,
        organizationRevision: 1,
        budget: 4,
      })
      expect(yield* standing(database.db, id)).toEqual({ recorded: 2, committed: 6 })
      expect(
        yield* reservations.reserve({
          runID: exact.run_id,
          agentID: exact.agent_id,
          organizationID: id,
          organizationRevision: 1,
          budget: exact.budget,
        }),
      ).toEqual(exact)
      yield* reservations.release(exact.run_id)
      expect(yield* standing(database.db, id)).toEqual({ recorded: 2, committed: 2 })
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("standing branch reservation covers only authenticated delegation and preserves settled costs", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const id = "org_77777777777777777777777777777777"
      const run = "run_standing_branch"
      const parent = SessionID.make("ses_standing_branch")
      const project = ProjectV2.ID.make("project_standing_branch")
      const agent = (id: string): RayaTask.Agent => ({
        id,
        name: id,
        role: "generalist",
        objective: "Coordinate the current request.",
        memoryScope: "project",
        capabilities: [],
        schedule: { kind: "manual" },
        access: "brief",
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      })
      const chief = agent("standing_chief")
      const child = agent("standing_child")
      const sales = agent("standing_sales")
      yield* database.db.insert(Organization).values({
        id,
        name: "Standing branch",
        budget: 20,
        revision: 1,
        time_created: 1,
        time_updated: 1,
      })
      yield* database.db.insert(Member).values(
        [chief, child, sales].map((item, position) => ({
          organization_id: id,
          agent_id: item.id,
          role: item.role,
          position,
          time_created: 1,
          time_updated: 1,
        })),
      )
      yield* database.db.insert(ProjectTable).values({
        id: project,
        worktree: AbsolutePath.make("/workspace"),
        sandboxes: [],
        time_created: 1,
        time_updated: 1,
      })
      const owner = { runID: run, agentID: chief.id, organizationID: id, organizationRevision: 1, budget: 20 }
      const session = {
        id: parent,
        project_id: project,
        slug: "standing-branch",
        directory: AbsolutePath.make("/workspace"),
        title: "Standing branch",
        version: "test",
        cost: 0,
        metadata: { rayaRoutine: owner },
        time_created: 1,
        time_updated: 1,
      }
      yield* database.db.insert(SessionTable).values(session)
      const reservations = make(database)
      const bound = { runID: run, agentID: chief.id, organizationID: id, organizationRevision: 1, budget: 20 }
      yield* reservations.reserve(bound)
      yield* reservations.link(run, parent)
      const store = RayaTaskDelegation.make(
        database,
        () => Effect.succeed({ id, name: "Standing branch", revision: 1, budget: 20 }),
        () => Effect.succeed(true),
      )
      const request = {
        source: "standing_first",
        senderID: chief.id,
        recipientID: child.id,
        parentRunID: run,
        organizationID: id,
        organizationRevision: 1,
        objective: "Review the supplied input and report the result.",
        budget: 5,
      }
      const allocation = { limit: 20, spent: 0 }
      const info = RayaTaskInfo.make(database)
      const activity = () =>
        info.activity(id, (id) => Effect.succeed({ name: id, role: "generalist", archived: false }))
      for (const patch of [
        { runID: "other_run" },
        { agentID: "other_agent" },
        { organizationID: "org_88888888888888888888888888888888" },
        { organizationRevision: 2 },
        { budget: 21 },
        { delegationID: "other_delegation" },
      ]) {
        yield* database.db
          .update(SessionTable)
          .set({ metadata: { rayaRoutine: { ...owner, ...patch } } })
          .where(eq(SessionTable.id, parent))
        expect(Exit.isFailure(yield* store.admit(request, chief, child, undefined, allocation).pipe(Effect.exit))).toBe(
          true,
        )
      }
      yield* database.db.update(SessionTable).set({ metadata: session.metadata }).where(eq(SessionTable.id, parent))
      yield* database.db.delete(SessionTable).where(eq(SessionTable.id, parent))
      expect(Exit.isFailure(yield* store.admit(request, chief, child, undefined, allocation).pipe(Effect.exit))).toBe(
        true,
      )
      yield* database.db.insert(SessionTable).values(session)
      yield* database.db.update(Reservation).set({ state: "settled", cost: 20 }).where(eq(Reservation.run_id, run))
      expect(Exit.isFailure(yield* store.admit(request, chief, child, undefined, allocation).pipe(Effect.exit))).toBe(
        true,
      )
      yield* database.db.update(Reservation).set({ state: "linked", cost: null }).where(eq(Reservation.run_id, run))
      yield* database.db.update(SessionTable).set({ cost: 20 }).where(eq(SessionTable.id, parent))
      yield* database.db.delete(Reservation).where(eq(Reservation.run_id, run))
      expect(Exit.isFailure(yield* store.admit(request, chief, child, undefined, allocation).pipe(Effect.exit))).toBe(
        true,
      )
      yield* database.db.update(SessionTable).set({ cost: 0 }).where(eq(SessionTable.id, parent))
      yield* reservations.reserve(bound)
      yield* reservations.link(run, parent)
      const first = yield* store.admit(request, chief, child, undefined, allocation)
      expect(first.record.state).toBe("queued")
      expect(first.record.budget).toBe(5)
      expect((yield* store.admit(request, chief, child, undefined, allocation)).record).toEqual(first.record)
      yield* store.admit(
        { ...request, source: "standing_second", recipientID: sales.id, budget: 4 },
        chief,
        sales,
        undefined,
        allocation,
      )
      const work = yield* database.db.select().from(Delegation).all()
      expect(work).toHaveLength(2)
      expect((yield* activity()).summary.committedCost).toBe(20)
      expect(
        Exit.isFailure(
          yield* reservations.reserve({ ...bound, runID: "run_extra", agentID: sales.id, budget: 1 }).pipe(Effect.exit),
        ),
      ).toBe(true)
      yield* database.db.update(SessionTable).set({ cost: 7 }).where(eq(SessionTable.id, parent))
      expect((yield* activity()).summary.committedCost).toBe(20)
      yield* reservations.settle(run, parent, 7)
      expect((yield* activity()).summary).toMatchObject({ standaloneCost: 7, committedCost: 16 })
      yield* reservations.reserve({ ...bound, runID: "run_exact", agentID: sales.id, budget: 4 })
      yield* reservations.release("run_exact")
      yield* database.db.update(Reservation).set({ cost: null }).where(eq(Reservation.run_id, run))
      expect((yield* activity()).summary).toMatchObject({ standaloneCost: 20, committedCost: 29 })
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})
