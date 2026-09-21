import { expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import {
  RayaRoutineOrganizationMemberTable as Member,
  RayaRoutineOrganizationTable as Organization,
} from "@opencode-ai/core/kilocode/routine.sql"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionID } from "@/session/schema"
import { direct, standing } from "@/kilocode/task/commitment"
import { make } from "@/kilocode/task/reservation"

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
      const reservations = make(database)
      const raced = yield* Effect.all(
        [
          reservations
            .reserve({
              runID: "run_one",
              agentID: "worker_one",
              organizationID: id,
              organizationRevision: 1,
              budget: 7,
            })
            .pipe(Effect.exit),
          reservations
            .reserve({
              runID: "run_two",
              agentID: "worker_two",
              organizationID: id,
              organizationRevision: 1,
              budget: 7,
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
      const project = ProjectV2.ID.make("project_standalone_reservation")
      yield* database.db.insert(ProjectTable).values({
        id: project,
        worktree: AbsolutePath.make("/workspace"),
        sandboxes: [],
        time_created: 1,
        time_updated: 1,
      })
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
      expect(yield* standing(database.db, id)).toEqual({ recorded: 0, committed: 7 })
      yield* reservations.settle(run, session, 2)
      expect(yield* direct(database.db, id)).toBe(0)
      expect(yield* standing(database.db, id)).toEqual({ recorded: 2, committed: 2 })
      const exact = yield* reservations.reserve({
        runID: "run_exact",
        agentID: "worker_three",
        organizationID: id,
        organizationRevision: 1,
        budget: 8,
      })
      expect(yield* standing(database.db, id)).toEqual({ recorded: 2, committed: 10 })
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
