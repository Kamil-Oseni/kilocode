import { expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { eq, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { RayaRoutineConversationTable as Conversation } from "@opencode-ai/core/kilocode/routine.sql"
import { RayaTaskInbox, status, posted } from "@/kilocode/task/inbox"
import type { RayaTask } from "@/kilocode/task"
import { SessionID } from "@/session/schema"

const agent = (id: string, enabled = true, execution?: RayaTask.Agent["execution"]): RayaTask.Agent => ({
  id,
  name: "Books",
  role: "accountant",
  objective: "Review accounts",
  capabilities: ["accounting"],
  memoryScope: "project",
  schedule: { kind: "manual" },
  enabled,
  createdAt: 1,
  updatedAt: 1,
  ...(execution ? { execution } : {}),
})

test("routine inbox state stays separate from unread", () => {
  expect(status(agent("a", false))).toBe("paused")
  expect(status(agent("a", true, { state: "active" }))).toBe("running")
  expect(status(agent("a", true, { state: "recovery" }))).toBe("failed")
  expect(status(agent("a"), { id: "run", agentID: "a", at: 1, sessionID: SessionID.make("ses_test"), status: "blocked", blockedReason: "waiting on you" })).toBe(
    "needs_input",
  )
  expect(status(agent("a"))).toBe("scheduled")
})

test("posted reports do not treat a running or empty completion as invented success", () => {
  const sid = SessionID.make("ses_test")
  expect(posted({ id: "run", agentID: "a", at: 1, sessionID: sid, status: "running" })).toBeUndefined()
  const done = posted({
    id: "run",
    agentID: "a",
    at: 1,
    sessionID: sid,
    status: "complete",
    outcome: { kind: "notify", summary: "", cost: 0 },
  })
  expect(done?.kind).toBe("report")
  expect(done?.source).toBe("report:run")
  expect(done?.body).toContain("not invented success")
  const need = posted({
    id: "run",
    agentID: "a",
    at: 1,
    sessionID: sid,
    status: "blocked",
    blockedReason: "waiting on you",
  })
  expect(need?.kind).toBe("decision")
  expect(need?.source).toBe("need:run")
  expect(need?.body).toContain("not a completed report")
  const failed = posted({ id: "run", agentID: "a", at: 1, sessionID: sid, status: "error" })
  expect(failed?.kind).toBe("report")
  expect(failed?.body).toContain("not a completed report")
  const timer = posted({
    id: 'timer:["agt",1,1]',
    agentID: "a",
    at: 1,
    sessionID: sid,
    status: "complete",
    outcome: { kind: "notify", summary: "Done", cost: 0 },
  })
  expect(timer?.source.startsWith("report:")).toBe(true)
  expect(timer?.occurrenceID).toBeUndefined()
  expect(timer?.source).not.toContain("[")
})

test("routine inbox publication is idempotent, unread ignores user messages, and conversation deletion drops messages", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const inbox = RayaTaskInbox.make(yield* Database.Service)
      const first = yield* inbox.publish({
        agentID: "agt_1",
        source: "user_1",
        kind: "user",
        body: "Why did expenses increase?",
      })
      expect(first.kind).toBe("user")
      const sid = SessionID.make("ses_followup")
      expect((yield* inbox.attach("agt_1", "user_1", sid)).sessionID).toBe(sid)
      expect(
        yield* inbox.publish({
          agentID: "agt_1",
          source: "user_1",
          kind: "user",
          body: "Why did expenses increase?",
        }),
      ).toEqual({ ...first, sessionID: sid })
      expect(
        Exit.isFailure(
          yield* inbox
            .publish({
              agentID: "agt_1",
              source: "user_1",
              kind: "user",
              body: "Why did expenses increase?",
              sessionID: SessionID.make("ses_other"),
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(
        Exit.isFailure(
          yield* inbox
            .publish({ agentID: "agt_1", source: "user_1", kind: "user", body: "Different follow-up" })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      const report = yield* inbox.publish({
        agentID: "agt_1",
        source: "report:occ_1",
        kind: "report",
        body: "Friday accounts review is complete.",
        occurrenceID: "occ_1",
      })
      const items = yield* inbox.summaries([agent("agt_1")], new Map())
      expect(items).toHaveLength(1)
      expect(items[0].conversationID.startsWith("rcv_")).toBe(true)
      expect(items[0].unread).toBe(1)
      expect(items[0].latest?.id).toBe(report.id)
      expect(items[0].state).toBe("scheduled")
      expect(yield* inbox.read("agt_1", report.time)).toBe(report.time)
      expect((yield* inbox.summaries([agent("agt_1")], new Map()))[0].unread).toBe(0)
      expect(yield* inbox.read("agt_1", 0)).toBe(report.time)
      yield* inbox.draft("agt_1", "Ask about travel")
      expect((yield* inbox.summaries([agent("agt_1")], new Map()))[0].draft).toBe("Ask about travel")
      expect(yield* inbox.draft("agt_1", "")).toBeNull()
      const page = yield* inbox.page("agt_1")
      expect(page.messages.map((item) => item.source)).toEqual(["user_1", "report:occ_1"])
      const db = (yield* Database.Service).db
      yield* db.delete(Conversation).where(eq(Conversation.agent_id, "agt_1")).run()
      expect(yield* db.get(sql`SELECT count(*) AS n FROM raya_routine_message WHERE agent_id = 'agt_1'`)).toEqual({
        n: 0,
      })
      expect(
        Exit.isFailure(
          yield* db
            .run(
              sql`INSERT INTO raya_routine_message (id, agent_id, source, kind, body, time_created) VALUES ('late', 'agt_1', 'late', 'report', 'no', 1)`,
            )
            .pipe(Effect.exit),
        ),
      ).toBe(true)
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})
