import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import { RayaTaskRunner } from "@/kilocode/task/runner"
import { RayaTaskInbox } from "@/kilocode/task/inbox"
import { RayaTaskSnapshot } from "@/kilocode/task/snapshot"
import { RayaGoal } from "@/kilocode/goal"
import { RayaGoalContinuation } from "@/kilocode/goal/continuation"
import type { MessageV2 } from "@/session/message-v2"
import { MessageID } from "@/session/schema"

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

function session(id: string) {
  return {
    id: SessionID.make(id),
    slug: "ask",
    title: "Accounts",
    projectID: ProjectV2.ID.make("project"),
    directory: "/tmp",
    version: "test",
    time: { created: Date.now(), updated: Date.now() },
  }
}

test("a paused worker follow-up starts one run without rewriting the assignment", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const storage = memory()
      const starts: string[] = []
      const runner = RayaTaskRunner.make({
        database,
        storage,
        sessions: {
          create: () =>
            Effect.sync(() => {
              starts.push("start")
              return session("ses_followup")
            }),
          get: () => Effect.die("unused"),
          messages: () => Effect.succeed([]),
          children: () => Effect.succeed([]),
        },
      })
      const inbox = RayaTaskInbox.make(database)
      const snapshots = RayaTaskSnapshot.make({ storage })
      const agent = yield* runner.tasks.create({
        name: "Accounts",
        role: "accountant",
        objective: "Review accounts",
        capabilities: ["accounting"],
        enabled: false,
        schedule: { kind: "manual" },
      })
      yield* inbox.publish({
        agentID: agent.id,
        source: "report:occ1",
        kind: "report",
        body: "Friday expenses increased in travel.",
        occurrenceID: "occ1",
      })
      const question = "Why did expenses increase on that Friday report?"
      const first = yield* inbox.admit({ agentID: agent.id, source: "user_1", kind: "user", body: question })
      expect(first.created).toBe(true)
      const run = yield* runner.ask(agent.id, question)
      expect(starts).toEqual(["start"])
      expect(run.sessionID).toBe(SessionID.make("ses_followup"))
      expect(run.trigger).toEqual({ kind: "manual" })
      const saved = yield* snapshots.find(run.id)
      expect(saved?.definition.objective).toBe("Review accounts")
      expect(saved?.objective).toContain(question)
      expect(saved?.objective).toContain("unchanged")
      expect(saved?.objective).toContain("Friday expenses increased in travel.")
      expect((yield* runner.tasks.get(agent.id)).objective).toBe("Review accounts")
      expect((yield* runner.tasks.get(agent.id)).enabled).toBe(false)
      expect((yield* runner.tasks.get(agent.id)).schedule).toEqual({ kind: "manual" })
      yield* inbox.attach(agent.id, "user_1", run.sessionID)
      expect((yield* inbox.admit({ agentID: agent.id, source: "user_1", kind: "user", body: question })).created).toBe(
        false,
      )
      yield* runner.ask(agent.id, question)
      expect(starts).toEqual(["start"])
      expect(yield* runner.tasks.runsFor(agent.id)).toHaveLength(1)
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("a follow-up while waiting on you resumes the same session", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const storage = memory()
      const runner = RayaTaskRunner.make({
        database,
        storage,
        sessions: {
          create: () => Effect.die("must not start another worker"),
          get: () => Effect.die("unused"),
          messages: () => Effect.succeed([]),
          children: () => Effect.succeed([]),
        },
      })
      const agent = yield* runner.tasks.create({
        name: "Accounts",
        role: "accountant",
        objective: "Review accounts",
        capabilities: ["accounting"],
        enabled: true,
        schedule: { kind: "manual" },
      })
      const sid = SessionID.make("ses_waiting")
      const now = Date.now()
      yield* storage.write(["raya", "goal", sid], {
        objective: "Review accounts",
        createdAt: now,
        updatedAt: now,
        usage: { turns: 1, continuations: 0, toolCalls: 0 },
        progress: [],
        status: "blocked",
        blockedReason: "waiting on you",
      })
      yield* runner.tasks.record({
        id: "occ1",
        agentID: agent.id,
        sessionID: sid,
        at: now,
        status: "running",
      })
      yield* runner.park(sid, true)
      const run = yield* runner.ask(agent.id, "Why did expenses increase?")
      expect(run.sessionID).toBe(sid)
      expect(yield* runner.tasks.runsFor(agent.id)).toHaveLength(1)
      const latest = (yield* runner.tasks.runsFor(agent.id))[0]
      expect(latest.status).toBe("running")
      const goal = yield* storage.read<{ objective: string; status: string }>(["raya", "goal", sid])
      expect(goal.objective).toContain("Why did expenses increase?")
      expect(goal.objective).toContain("Review accounts")
      expect(goal.status).toBe("active")
      expect((yield* runner.tasks.get(agent.id)).objective).toBe("Review accounts")
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("a persisted routine user turn resumes its dangling model loop without replaying attachment intake", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const storage = memory()
      const sid = SessionID.make("ses_attachment_recovery")
      const rows: MessageV2.WithParts[] = []
      const sessions = {
        get: () => Effect.succeed(session(sid)),
        messages: () => Effect.succeed(rows),
        children: () => Effect.succeed([]),
      }
      const inbox = RayaTaskInbox.make(database)
      const goals = RayaGoal.make({ storage, sessions })
      const file = {
        id: "b95bb7ad-766b-4fbb-972d-bcfdd29a9bf0",
        name: "ledger.txt",
        mime: "text/plain",
        size: 6,
        data: Buffer.from("ledger").toString("base64"),
      }
      yield* inbox.publish({
        agentID: "books",
        source: "user_recovery",
        kind: "user",
        body: "Review ledger",
        attachments: [file],
      })
      yield* inbox.attach("books", "user_recovery", sid)
      yield* goals.create(sid, "Review the attached ledger")
      const queued = yield* goals.continued(sid)
      if (!queued?.dispatch) throw new Error("Missing queued dispatch")
      const started = yield* goals.dispatched(sid, queued.dispatch.id)
      if (!started?.dispatch?.messageID) throw new Error("Missing started dispatch")
      const delivery = yield* inbox.delivery(sid, started.dispatch.messageID)
      expect(delivery?.delivered).toBe(false)
      expect(delivery?.files[0]).toMatchObject({ filename: file.name, url: `data:text/plain;base64,${file.data}` })
      const user = {
        info: {
          id: started.dispatch.messageID,
          sessionID: sid,
          role: "user" as const,
          time: { created: Date.now() },
          agent: "generalist",
          model: { providerID: "test", modelID: "test" },
        },
        parts: [],
      } as unknown as MessageV2.WithParts
      rows.push(user)
      let loops = 0
      yield* RayaGoalContinuation.resume({
        database,
        sessionID: sid,
        storage,
        sessions,
        run: async () => {
          throw new Error("must not enqueue the persisted user message again")
        },
        loop: async () => {
          loops++
          rows.push({
            info: {
              id: MessageID.ascending(),
              parentID: started.dispatch!.messageID!,
              sessionID: sid,
              role: "assistant",
              time: { created: Date.now(), completed: Date.now() },
              agent: "generalist",
              mode: "generalist",
              path: { cwd: process.cwd(), root: process.cwd() },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              providerID: "test",
              modelID: "test",
              finish: "stop",
            },
            parts: [],
          } as unknown as MessageV2.WithParts)
        },
      })
      expect(loops).toBe(1)
      expect((yield* inbox.delivery(sid, started.dispatch.messageID))?.delivered).toBe(true)
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("routine startup claims an admitted follow-up that crashed before session attachment", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const storage = memory()
      const created: string[] = []
      const runner = RayaTaskRunner.make({
        database,
        storage,
        sessions: {
          create: () =>
            Effect.sync(() => {
              created.push("session")
              return session("ses_recovered_admission")
            }),
          get: () => Effect.succeed(session("ses_recovered_admission")),
          messages: () => Effect.succeed([]),
          children: () => Effect.succeed([]),
        },
      })
      const agent = yield* runner.tasks.create({
        name: "Accounts",
        role: "accountant",
        objective: "Review accounts",
        capabilities: ["accounting"],
        access: "full",
        enabled: false,
        schedule: { kind: "manual" },
      })
      const inbox = RayaTaskInbox.make(database)
      yield* inbox.admit({
        agentID: agent.id,
        source: "user_crash",
        kind: "user",
        body: "Resume this after restart",
        attachments: [
          {
            id: "01f6781f-76ac-455b-8df7-21490a60c6dd",
            name: "resume.txt",
            mime: "text/plain",
            size: 6,
            data: Buffer.from("resume").toString("base64"),
          },
        ],
      })
      expect((yield* inbox.pending(agent.id))?.sessionID).toBeUndefined()
      yield* runner.revive()
      expect(created).toEqual(["session"])
      expect(yield* inbox.pending(agent.id)).toBeUndefined()
      expect((yield* inbox.page(agent.id)).messages[0]?.sessionID).toBe(SessionID.make("ses_recovered_admission"))
      expect(yield* runner.tasks.runsFor(agent.id)).toHaveLength(1)
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})
