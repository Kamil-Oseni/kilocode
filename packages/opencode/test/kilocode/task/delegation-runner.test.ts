import { expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import { RayaTaskDelegation } from "@/kilocode/task/delegation"
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

test("chief of staff obtains a tracked accounting result without rewriting either assignment", async () => {
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
              return session("ses_books")
            }),
          get: () => Effect.die("unused"),
          messages: () => Effect.succeed([]),
          children: () => Effect.succeed([]),
        },
      })
      const snapshots = RayaTaskSnapshot.make({ storage })
      const chief = yield* runner.tasks.create({
        name: "Chief of Staff",
        role: "generalist",
        objective: "Coordinate Friday close.",
        access: "brief",
        enabled: true,
        schedule: { kind: "manual" },
      })
      const books = yield* runner.tasks.create({
        name: "Accounting",
        role: "accountant",
        objective: "Reconcile receipts.",
        capabilities: ["accounting"],
        access: "full",
        enabled: true,
        schedule: { kind: "manual" },
      })
      const first = yield* runner.delegate({
        source: "dlg_friday",
        senderID: chief.id,
        recipientID: books.id,
        objective: "List missing Friday receipts.",
        expected: "Named missing receipts, not a payment.",
      })
      expect(first.state).toBe("running")
      expect(starts).toEqual(["start"])
      expect(first.sessionID).toBe(SessionID.make("ses_books"))
      const saved = yield* snapshots.find(first.childRunID!)
      expect(saved?.definition.objective).toBe("Reconcile receipts.")
      expect(saved?.objective).toContain("List missing Friday receipts.")
      expect(saved?.objective).toContain("unchanged")
      expect((yield* runner.tasks.get(chief.id)).objective).toBe("Coordinate Friday close.")
      expect((yield* runner.tasks.get(books.id)).objective).toBe("Reconcile receipts.")
      expect((yield* runner.delegate({
        source: "dlg_friday",
        senderID: chief.id,
        recipientID: books.id,
        objective: "List missing Friday receipts.",
        expected: "Named missing receipts, not a payment.",
      })).state).toBe("running")
      expect(starts).toEqual(["start"])
      const paused = yield* runner.tasks.create({
        name: "Quiet",
        role: "reviewer",
        objective: "Review later.",
        access: "brief",
        enabled: false,
        schedule: { kind: "manual" },
      })
      const denied = yield* runner.delegate({
        source: "dlg_pause",
        senderID: chief.id,
        recipientID: paused.id,
        objective: "Review the Friday close.",
      })
      expect(denied.state).toBe("failed")
      expect(starts).toEqual(["start"])
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("stopping a parent cancels live descendants without rewriting assignments", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const storage = memory()
      const starts: string[] = []
      const halted: string[] = []
      const runner = RayaTaskRunner.make({
        database,
        storage,
        halt: (sessionID) =>
          Effect.sync(() => {
            halted.push(sessionID)
          }),
        sessions: {
          create: () =>
            Effect.sync(() => {
              starts.push("start")
              return session(`ses_${starts.length}`)
            }),
          get: () => Effect.die("unused"),
          messages: () => Effect.succeed([]),
          children: () => Effect.succeed([]),
        },
      })
      const chief = yield* runner.tasks.create({
        name: "Chief of Staff",
        role: "generalist",
        objective: "Coordinate Friday close.",
        access: "brief",
        enabled: true,
        schedule: { kind: "manual" },
      })
      const books = yield* runner.tasks.create({
        name: "Accounting",
        role: "accountant",
        objective: "Reconcile receipts.",
        capabilities: ["accounting"],
        access: "full",
        enabled: true,
        schedule: { kind: "manual" },
      })
      const legal = yield* runner.tasks.create({
        name: "Legal",
        role: "reviewer",
        objective: "Review contracts.",
        access: "brief",
        enabled: true,
        schedule: { kind: "manual" },
      })
      const parent = yield* runner.delegate({
        source: "dlg_stop",
        senderID: chief.id,
        recipientID: books.id,
        objective: "List missing Friday receipts.",
      })
      expect(parent.state).toBe("running")
      const child = yield* runner.delegate({
        source: "dlg_stop_child",
        senderID: books.id,
        recipientID: legal.id,
        parentID: parent.id,
        objective: "Confirm the missing receipts against policy.",
      })
      expect(child.state).toBe("running")
      const stopped = yield* runner.stop(parent.id)
      expect(stopped.state).toBe("cancelled")
      expect(stopped.reason).toBe("Stopped by the user.")
      expect(halted).toEqual([parent.sessionID!, child.sessionID!])
      expect((yield* runner.stop(parent.id)).state).toBe("cancelled")
      expect((yield* RayaTaskDelegation.make(database).get(child.id)).state).toBe("cancelled")
      expect((yield* runner.tasks.get(chief.id)).objective).toBe("Coordinate Friday close.")
      expect((yield* runner.tasks.get(books.id)).objective).toBe("Reconcile receipts.")
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("parent run cost stays independent of a completed child request", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const storage = memory()
      const runner = RayaTaskRunner.make({
        database,
        storage,
        sessions: {
          create: () => Effect.sync(() => session("ses_books")),
          get: () => Effect.die("unused"),
          messages: ({ sessionID }) =>
            Effect.succeed([
              {
                info: {
                  role: "assistant",
                  cost: sessionID === SessionID.make("ses_chief") ? 2 : 1.5,
                },
                parts: [],
              },
            ] as never),
          children: () => Effect.succeed([]),
        },
      })
      const inbox = RayaTaskInbox.make(database)
      const store = RayaTaskDelegation.make(database)
      const chief = yield* runner.tasks.create({
        name: "Chief of Staff",
        role: "generalist",
        objective: "Coordinate Friday close.",
        access: "brief",
        enabled: true,
        schedule: { kind: "manual" },
      })
      const books = yield* runner.tasks.create({
        name: "Accounting",
        role: "accountant",
        objective: "Reconcile receipts.",
        capabilities: ["accounting"],
        access: "full",
        enabled: true,
        schedule: { kind: "manual" },
      })
      const now = Date.now()
      const parent = SessionID.make("ses_chief")
      yield* runner.tasks.record({ id: "occ_parent", agentID: chief.id, sessionID: parent, at: now, status: "running" })
      const child = yield* runner.delegate({
        source: "dlg_cost",
        senderID: chief.id,
        recipientID: books.id,
        parentRunID: "occ_parent",
        objective: "List missing Friday receipts.",
      })
      expect(child.parentRunID).toBe("occ_parent")
      expect(
        Exit.isFailure(
          yield* runner
            .delegate({
              source: "dlg_missing",
              senderID: chief.id,
              recipientID: books.id,
              parentRunID: "occ_missing",
              objective: "List missing Friday receipts.",
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      yield* storage.write(["raya", "goal", child.sessionID!], {
        objective: "Reconcile receipts.",
        status: "complete",
        createdAt: now,
        updatedAt: now,
        usage: { turns: 1, continuations: 0, toolCalls: 1 },
        progress: [],
        audit: { summary: "Travel receipts are missing.", verifiedAt: now, requirements: [] },
      })
      yield* runner.settle(child.sessionID!)
      expect((yield* store.get(child.id)).cost).toBe(1.5)
      yield* storage.write(["raya", "goal", parent], {
        objective: "Coordinate Friday close.",
        status: "complete",
        createdAt: now,
        updatedAt: now,
        usage: { turns: 1, continuations: 0, toolCalls: 1 },
        progress: [],
        audit: { summary: "Friday close used the accounting reply.", verifiedAt: now, requirements: [] },
      })
      yield* runner.settle(parent)
      const run = (yield* runner.tasks.runsFor(chief.id)).find((item) => item.id === "occ_parent")
      expect(run?.outcome?.cost).toBe(2)
      expect(run?.outcome?.cost).not.toBe(3.5)
      const report = (yield* inbox.page(chief.id)).messages.find((item) => item.source === "report:occ_parent")
      expect(report?.body).toContain("Friday close used the accounting reply.")
      expect(report?.body).toContain("Accounting: completed")
      expect(report?.body).toContain("Child cost $1.5")
      expect(report?.body).toContain("not added to this run's total")
      expect(report?.body).not.toContain("consensus")
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})
