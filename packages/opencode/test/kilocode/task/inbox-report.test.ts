import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import { RayaTaskRunner } from "@/kilocode/task/runner"
import { RayaTaskInbox } from "@/kilocode/task/inbox"

function memory() {
  const data = new Map<string, unknown>()
  return {
    create: (key: string[], value: unknown) =>
      Effect.sync(() => {
        const id = key.join("/")
        if (data.has(id)) return false
        data.set(id, value)
        return true
      }),
    replace: (key: string[], value: unknown) =>
      Effect.sync(() => {
        data.set(key.join("/"), value)
      }),
    read<T>(key: string[]) {
      return Effect.gen(function* () {
        const found = data.get(key.join("/"))
        if (found === undefined) return yield* new Storage.NotFoundError({ message: "missing" })
        return found as T
      })
    },
    write: (key: string[], value: unknown) =>
      Effect.sync(() => {
        data.set(key.join("/"), value)
      }),
    remove: (key: string[]) =>
      Effect.sync(() => {
        data.delete(key.join("/"))
      }),
    update<T>(key: string[], fn: (draft: T) => void) {
      return Effect.gen(function* () {
        const found = data.get(key.join("/")) as T
        fn(found)
        data.set(key.join("/"), found)
        return found
      })
    },
    list: (prefix: string[]) => {
      const start = prefix.join("/")
      return Effect.sync(() => [...data.keys()].filter((key) => key.startsWith(start)).map((key) => key.split("/")))
    },
  }
}

test("settlement publishes one durable inbox report and retries without duplicating it", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const storage = memory()
      const sessions = {
        create: () => Effect.die("must not create another session"),
        get: () => Effect.die("unused"),
        messages: () => Effect.succeed([]),
        children: () => Effect.succeed([]),
      }
      const runner = RayaTaskRunner.make({ database, storage, sessions })
      const inbox = RayaTaskInbox.make(database)
      const agent = yield* runner.tasks.create({
        name: "Accounts",
        role: "accountant",
        objective: "Review accounts",
        capabilities: ["accounting"],
        enabled: false,
        schedule: { kind: "manual" },
      })
      const sid = SessionID.make("ses_inbox_report")
      const now = Date.now()
      const goal = {
        objective: "Review accounts",
        createdAt: now,
        updatedAt: now,
        usage: { turns: 1, continuations: 0, toolCalls: 1 },
        progress: [],
      }
      yield* storage.write(["raya", "goal", sid], { ...goal, status: "active" })
      yield* runner.tasks.record({ id: "occ1", agentID: agent.id, sessionID: sid, at: now, status: "running" })
      yield* runner.settle(sid)
      expect((yield* inbox.page(agent.id)).messages).toEqual([])
      yield* storage.write(["raya", "goal", sid], {
        ...goal,
        status: "complete",
        audit: { summary: "Friday expenses increased in travel.", verifiedAt: now, requirements: [] },
      })
      yield* runner.settle(sid)
      const first = yield* inbox.page(agent.id)
      expect(first.messages).toHaveLength(1)
      expect(first.messages[0].kind).toBe("report")
      expect(first.messages[0].source).toBe("report:occ1")
      expect(first.messages[0].body).toContain("Friday expenses increased in travel.")
      expect(first.messages[0].body).not.toContain("invented")
      expect((yield* inbox.summaries([agent], new Map()))[0].unread).toBe(1)
      yield* runner.settle(sid)
      expect((yield* inbox.page(agent.id)).messages).toHaveLength(1)
      const later = SessionID.make("ses_inbox_wait")
      yield* runner.tasks.record({ id: "occ2", agentID: agent.id, sessionID: later, at: now + 1, status: "running" })
      yield* runner.park(later, true)
      yield* runner.park(later, true)
      const waiting = yield* inbox.page(agent.id)
      expect(waiting.messages.map((item) => item.source)).toEqual(["report:occ1", "need:occ2"])
      expect(waiting.messages[1].kind).toBe("decision")
      expect(waiting.messages[1].body).toContain("not a completed report")
      yield* runner.park(later, false)
      yield* storage.write(["raya", "goal", later], {
        ...goal,
        status: "complete",
        audit: { summary: "Approved the travel exception.", verifiedAt: now + 2, requirements: [] },
      })
      yield* runner.settle(later)
      const page = yield* inbox.page(agent.id)
      expect(page.messages.map((item) => item.source)).toEqual(["report:occ1", "need:occ2", "report:occ2"])
      expect(page.messages[2].body).toContain("Approved the travel exception.")
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("settlement after a persisted completed run publishes one report with file cards", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const storage = memory()
      const sessions = {
        create: () => Effect.die("must not create another session"),
        get: () => Effect.die("unused"),
        messages: () => Effect.succeed([]),
        children: () => Effect.succeed([]),
      }
      const runner = RayaTaskRunner.make({ database, storage, sessions })
      const inbox = RayaTaskInbox.make(database)
      const agent = yield* runner.tasks.create({
        name: "Accounts",
        role: "accountant",
        objective: "Review accounts",
        capabilities: ["accounting"],
        enabled: false,
        schedule: { kind: "manual" },
      })
      const sid = SessionID.make("ses_inbox_crash")
      const now = Date.now()
      yield* runner.tasks.record({
        id: "occ_crash",
        agentID: agent.id,
        sessionID: sid,
        at: now,
        status: "complete",
        outcome: {
          kind: "notify",
          summary: "Friday close attached the ledger.",
          evidence: ["receipts/Q3-close/ledger.pdf", "Travel increased versus last week."],
          cost: 0,
        },
      })
      expect((yield* inbox.page(agent.id)).messages).toEqual([])
      yield* runner.settle(sid)
      const first = yield* inbox.page(agent.id)
      expect(first.messages).toHaveLength(1)
      expect(first.messages[0].kind).toBe("report")
      expect(first.messages[0].source).toBe("report:occ_crash")
      expect(first.messages[0].files).toEqual([{ name: "ledger.pdf", path: "receipts/Q3-close/ledger.pdf" }])
      yield* runner.settle(sid)
      expect((yield* inbox.page(agent.id)).messages).toHaveLength(1)
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})
