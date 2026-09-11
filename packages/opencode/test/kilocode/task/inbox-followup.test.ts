import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import { RayaTaskRunner } from "@/kilocode/task/runner"
import { RayaTaskInbox } from "@/kilocode/task/inbox"
import { RayaTaskSnapshot } from "@/kilocode/task/snapshot"

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
