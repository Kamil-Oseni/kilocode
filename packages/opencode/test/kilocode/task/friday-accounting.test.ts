import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import { upcoming } from "@/kilocode/task/cron"
import { RayaTask } from "@/kilocode/task"
import { RayaTaskInbox } from "@/kilocode/task/inbox"
import { RayaTaskRunner } from "@/kilocode/task/runner"
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

test("Friday accounting reports, follow-up, and the next occurrence share one conversation", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const storage = memory()
      const created: unknown[] = []
      let n = 0
      const runner = RayaTaskRunner.make({
        database,
        storage,
        sessions: {
          create: (input) =>
            Effect.sync(() => {
              n += 1
              created.push(input?.metadata)
              return session(`ses_friday_${n}`)
            }),
          get: () => Effect.die("unused"),
          messages: () => Effect.succeed([]),
          children: () => Effect.succeed([]),
        },
      })
      const inbox = RayaTaskInbox.make(database)
      const snapshots = RayaTaskSnapshot.make({ storage })
      const zone = "America/New_York"
      const expr = "0 18 * * 5"
      const forecast = yield* RayaTask.forecast({ kind: "cron", expr, tz: zone }, Date.parse("2026-09-01T00:00:00Z"))
      expect(forecast.schedule).toEqual({ kind: "cron", expr, tz: zone })
      expect(forecast.occurrences).toHaveLength(3)
      const first = forecast.occurrences[0]!
      const second = forecast.occurrences[1]!
      expect(first).toBe(yield* upcoming(expr, Date.parse("2026-09-01T00:00:00Z"), zone))
      expect(second).toBe(yield* upcoming(expr, first + 1, zone))
      const stamp = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        weekday: "short",
        hour: "numeric",
        hourCycle: "h23",
      }).formatToParts(first)
      expect(stamp.find((part) => part.type === "weekday")?.value).toBe("Fri")
      expect(stamp.find((part) => part.type === "hour")?.value).toBe("18")
      const books = yield* runner.tasks.create({
        name: "Accounting",
        role: "accountant",
        objective: "Reconcile Friday receipts and name anything missing.",
        capabilities: ["accounting"],
        access: "full",
        enabled: true,
        schedule: { kind: "cron", expr, tz: zone },
        output: {
          destination: "conversation",
          description: "Friday close summary",
          criteria: [
            {
              id: "receipts",
              description: "Named missing receipts",
              verification: "Inspect the Friday receipt list.",
            },
          ],
        },
      })
      yield* storage.replace(
        ["raya", "agent"],
        [{ ...books, createdAt: first - 86_400_000, scheduleUpdatedAt: first - 86_400_000 }],
      )
      expect((yield* runner.preview(first - 1))[0]?.nextRun).toBe(first)
      yield* runner.tick(first - 1)
      expect(yield* runner.tasks.runsFor(books.id)).toEqual([])
      yield* runner.tick(first + 30_000)
      const started = yield* runner.tasks.runsFor(books.id)
      expect(started).toHaveLength(1)
      const run = started[0]!
      expect(run.trigger).toMatchObject({
        kind: "timer",
        scheduledAt: first,
        tz: zone,
        observedAt: first + 30_000,
      })
      expect(created[0]).toMatchObject({
        rayaRoutine: {
          version: 2,
          agentID: books.id,
          runID: run.id,
          scheduleVersion: 1,
          trigger: { kind: "timer", scheduledAt: first, tz: zone },
        },
      })
      const now = Date.now()
      yield* storage.write(["raya", "goal", run.sessionID], {
        objective: "Reconcile Friday receipts and name anything missing.",
        status: "complete",
        createdAt: now,
        updatedAt: now,
        usage: { turns: 1, continuations: 0, toolCalls: 1 },
        progress: [],
        criteria: [
          {
            id: "receipts",
            description: "Named missing receipts",
            verification: "Inspect the Friday receipt list.",
          },
        ],
        audit: {
          summary: "Travel receipts are missing for Friday close.",
          verifiedAt: now,
          requirements: [
            {
              criterionID: "receipts",
              requirement: "Named missing receipts",
              passed: true,
              evidence: [{ callID: "read", summary: "Travel folder has no Friday receipts." }],
            },
          ],
        },
      })
      yield* runner.settle(run.sessionID)
      const closed = (yield* runner.tasks.runsFor(books.id))[0]!
      expect(closed.status).toBe("complete")
      expect(closed.outcome?.verification).toEqual({
        at: now,
        requirements: [
          {
            criterionID: "receipts",
            requirement: "Named missing receipts",
            verification: "Inspect the Friday receipt list.",
            required: true,
            passed: true,
            evidence: ["Travel folder has no Friday receipts."],
          },
        ],
      })
      const reported = yield* inbox.page(books.id)
      expect(reported.messages).toHaveLength(1)
      expect(reported.messages[0]?.kind).toBe("report")
      expect(reported.messages[0]?.source).toBe(`report:${run.id}`)
      expect(reported.messages[0]?.occurrenceID).toBe(run.id)
      expect(reported.messages[0]?.body).toContain("Travel receipts are missing for Friday close.")
      expect(reported.messages[0]?.body).not.toContain("invented")
      const question = "Why did expenses increase on that Friday report?"
      const asked = yield* inbox.admit({ agentID: books.id, source: "user_friday", kind: "user", body: question })
      expect(asked.created).toBe(true)
      const follow = yield* runner.ask(books.id, question)
      expect(follow.trigger).toEqual({ kind: "manual" })
      expect(follow.sessionID).not.toBe(run.sessionID)
      const saved = yield* snapshots.find(follow.id)
      expect(saved?.definition.objective).toBe("Reconcile Friday receipts and name anything missing.")
      expect(saved?.objective).toContain(question)
      expect(saved?.objective).toContain("unchanged")
      expect(saved?.objective).toContain("Travel receipts are missing for Friday close.")
      expect(saved?.objective).toContain("Do not invent figures")
      expect((yield* runner.tasks.get(books.id)).objective).toBe("Reconcile Friday receipts and name anything missing.")
      expect((yield* runner.tasks.get(books.id)).schedule).toEqual({ kind: "cron", expr, tz: zone })
      yield* inbox.attach(books.id, "user_friday", follow.sessionID)
      yield* storage.write(["raya", "goal", follow.sessionID], {
        objective: saved?.objective,
        status: "complete",
        createdAt: now + 1,
        updatedAt: now + 1,
        usage: { turns: 1, continuations: 0, toolCalls: 0 },
        progress: [],
        audit: {
          summary: "The Friday report named missing travel receipts. No extra amount was invented.",
          verifiedAt: now + 1,
          requirements: [],
        },
      })
      yield* runner.settle(follow.sessionID)
      expect((yield* runner.tasks.runsFor(books.id)).every((item) => item.status !== "running")).toBe(true)
      yield* runner.tick(second + 30_000)
      const history = yield* runner.tasks.runsFor(books.id)
      expect(history).toHaveLength(3)
      const later = history.find((item) => item.trigger?.kind === "timer" && item.trigger.scheduledAt === second)
      expect(later?.trigger).toMatchObject({ kind: "timer", scheduledAt: second, tz: zone })
      yield* storage.write(["raya", "goal", later!.sessionID], {
        objective: "Reconcile Friday receipts and name anything missing.",
        status: "complete",
        createdAt: now + 2,
        updatedAt: now + 2,
        usage: { turns: 1, continuations: 0, toolCalls: 1 },
        progress: [],
        criteria: [
          {
            id: "receipts",
            description: "Named missing receipts",
            verification: "Inspect the Friday receipt list.",
          },
        ],
        audit: {
          summary: "The next Friday close found the travel receipts.",
          verifiedAt: now + 2,
          requirements: [
            {
              criterionID: "receipts",
              requirement: "Named missing receipts",
              passed: true,
              evidence: [{ callID: "read", summary: "Travel receipts arrived after the first close." }],
            },
          ],
        },
      })
      yield* runner.settle(later!.sessionID)
      const page = yield* inbox.page(books.id)
      expect(page.messages.map((item) => item.source)).toEqual([
        `report:${run.id}`,
        "user_friday",
        `report:${follow.id}`,
        `report:${later!.id}`,
      ])
      expect(page.messages.filter((item) => item.kind === "report")).toHaveLength(3)
      expect(page.messages.at(-1)?.body).toContain("The next Friday close found the travel receipts.")
      expect((yield* inbox.summaries([books], new Map()))[0]?.unread).toBe(3)
      expect((yield* runner.tasks.get(books.id)).schedule).toEqual({ kind: "cron", expr, tz: zone })
      expect(n).toBe(3)
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})
