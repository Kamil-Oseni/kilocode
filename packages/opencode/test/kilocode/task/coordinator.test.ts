import { expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { RayaRoutineOrganizationTable as Organization } from "@opencode-ai/core/kilocode/routine.sql"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { MessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { make } from "@/kilocode/task/coordinator"
import { MessageID, SessionID } from "@/session/schema"

test("coordinator cost binds one exact main-chat message and excludes mixed organizations and Routine sessions", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const project = ProjectV2.ID.make("project_coordinator_cost")
      const first = "org_11111111111111111111111111111111"
      const second = "org_22222222222222222222222222222222"
      yield* database.db.insert(ProjectTable).values({
        id: project,
        worktree: AbsolutePath.make("/workspace"),
        sandboxes: [],
        time_created: 1,
        time_updated: 1,
      })
      yield* database.db.insert(Organization).values([
        {
          id: first,
          name: "First",
          purpose: null,
          policy: null,
          budget: 10,
          revision: 1,
          archived_at: null,
          time_created: 1,
          time_updated: 1,
        },
        {
          id: second,
          name: "Second",
          purpose: null,
          policy: null,
          budget: 10,
          revision: 1,
          archived_at: null,
          time_created: 1,
          time_updated: 1,
        },
      ])
      const chat = SessionID.make("ses_coordinator_cost")
      const routine = SessionID.make("ses_coordinator_routine")
      const base = {
        project_id: project,
        slug: "coordinator",
        directory: AbsolutePath.make("/workspace"),
        title: "Coordinator",
        version: "test",
        time_created: 1,
        time_updated: 1,
      }
      yield* database.db.insert(SessionTable).values([
        { ...base, id: chat },
        { ...base, id: routine, metadata: { rayaRoutine: { agentID: "worker" } } },
      ])
      const chatMessage = MessageID.make("msg_coordinator_cost")
      const routineMessage = MessageID.make("msg_coordinator_routine")
      const message = (cost: number) =>
        ({
          role: "assistant",
          time: { created: 1, completed: 2 },
          parentID: MessageID.make("msg_parent"),
          modelID: "test",
          providerID: "test",
          mode: "build",
          agent: "build",
          path: { cwd: "/workspace", root: "/workspace" },
          cost,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }) as never
      yield* database.db.insert(MessageTable).values([
        { id: chatMessage, session_id: chat, data: message(3.25), time_created: 1 },
        { id: routineMessage, session_id: routine, data: message(9), time_created: 1 },
      ])
      const coordinator = make(database)
      const attributed = yield* coordinator.bind({
        messageID: chatMessage,
        sessionID: chat,
        organizationID: first,
        organizationRevision: 1,
      })
      expect(attributed?.state).toBe("attributed")
      expect(yield* coordinator.cost(first)).toBe(3.25)
      expect(
        yield* coordinator.bind({
          messageID: routineMessage,
          sessionID: routine,
          organizationID: first,
          organizationRevision: 1,
        }),
      ).toBeUndefined()
      expect(yield* coordinator.cost(first)).toBe(3.25)
      const wrong = yield* coordinator
        .bind({
          messageID: chatMessage,
          sessionID: SessionID.make("ses_different"),
          organizationID: first,
          organizationRevision: 1,
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(wrong)).toBe(true)
      const ambiguous = yield* coordinator.bind({
        messageID: chatMessage,
        sessionID: chat,
        organizationID: second,
        organizationRevision: 1,
      })
      expect(ambiguous?.state).toBe("ambiguous")
      expect(yield* coordinator.cost(first)).toBe(0)
      expect(yield* coordinator.cost(second)).toBe(0)
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})
