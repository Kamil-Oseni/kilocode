import { expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import { RayaTask } from "@/kilocode/task"
import { RayaTaskDelegation } from "@/kilocode/task/delegation"
import { RayaTaskInbox } from "@/kilocode/task/inbox"
import { RayaTaskOrganization } from "@/kilocode/task/organization"
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
      expect(
        (yield* runner.delegate({
          source: "dlg_friday",
          senderID: chief.id,
          recipientID: books.id,
          objective: "List missing Friday receipts.",
          expected: "Named missing receipts, not a payment.",
        })).state,
      ).toBe("running")
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

test("queued organization work cannot start under a later company revision", async () => {
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
              return session("ses_stale_organization")
            }),
          get: () => Effect.die("unused"),
          messages: () => Effect.succeed([]),
          children: () => Effect.succeed([]),
        },
      })
      const chief = yield* runner.tasks.create({
        name: "Chief",
        objective: "Assign work",
        access: "brief",
        schedule: { kind: "manual" },
      })
      const books = yield* runner.tasks.create({
        name: "Books",
        role: "accountant",
        objective: "Review accounts",
        capabilities: ["accounting"],
        access: "brief",
        schedule: { kind: "manual" },
      })
      const organizations = RayaTaskOrganization.make(database, runner.tasks, storage)
      const organization = yield* organizations.create({
        name: "Company",
        members: [
          { agentID: chief.id, role: "Chief" },
          { agentID: books.id, role: "Books" },
        ],
        delegations: [{ senderID: chief.id, recipientID: books.id }],
      })
      const outsider = yield* runner.tasks.create({
        name: "Outside lead",
        objective: "Assign independent work",
        access: "brief",
        schedule: { kind: "manual" },
      })
      const first = yield* runner.delegate({
        source: "dlg_first",
        senderID: outsider.id,
        recipientID: books.id,
        objective: "Complete the earlier review.",
      })
      expect(first.state).toBe("running")
      const queued = yield* runner.delegate({
        source: "dlg_stale_organization",
        senderID: chief.id,
        recipientID: books.id,
        organizationID: organization.id,
        organizationRevision: organization.revision,
        objective: "Review this company close.",
      })
      expect(queued.state).toBe("queued")
      yield* organizations.update(organization.id, { expectedRevision: 1, name: "Renamed company" })
      const now = Date.now()
      yield* storage.write(["raya", "goal", first.sessionID!], {
        objective: "Complete the earlier review.",
        status: "complete",
        createdAt: now,
        updatedAt: now,
        usage: { turns: 1, continuations: 0, toolCalls: 0 },
        progress: [],
        audit: { summary: "Earlier review complete.", verifiedAt: now, requirements: [] },
      })

      yield* runner.settle(first.sessionID!)
      const stopped = yield* RayaTaskDelegation.make(database).get(queued.id)
      expect(stopped.state).toBe("failed")
      expect(stopped.reason).toBe("The organization no longer authorizes this delegation.")
      expect(starts).toEqual(["start"])
      expect((yield* runner.tasks.runsFor(books.id)).filter((run) => run.status === "running")).toEqual([])
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("organization authority is rechecked after the worker startup claim is acquired", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const base = memory()
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const storage = {
        ...base,
        create: (key: string[], value: unknown) => {
          if (key[1] !== "agent-claims") return base.create(key, value)
          return base.create(key, value).pipe(
            Effect.tap((created) =>
              created
                ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
                : Effect.void,
            ),
          )
        },
      }
      const starts: string[] = []
      const runner = RayaTaskRunner.make({
        database,
        storage,
        sessions: {
          create: () =>
            Effect.sync(() => {
              starts.push("start")
              return session("ses_claimed_organization")
            }),
          get: () => Effect.die("unused"),
          messages: () => Effect.succeed([]),
          children: () => Effect.succeed([]),
        },
      })
      const chief = yield* runner.tasks.create({
        name: "Chief",
        objective: "Assign work",
        access: "brief",
        schedule: { kind: "manual" },
      })
      const books = yield* runner.tasks.create({
        name: "Books",
        role: "accountant",
        objective: "Review accounts",
        capabilities: ["accounting"],
        access: "brief",
        schedule: { kind: "manual" },
      })
      const organizations = RayaTaskOrganization.make(database, runner.tasks, storage)
      const organization = yield* organizations.create({
        name: "Company",
        members: [
          { agentID: chief.id, role: "Chief" },
          { agentID: books.id, role: "Books" },
        ],
        delegations: [{ senderID: chief.id, recipientID: books.id }],
      })
      const pending = yield* runner
        .delegate({
          source: "dlg_claimed_organization",
          senderID: chief.id,
          recipientID: books.id,
          organizationID: organization.id,
          organizationRevision: organization.revision,
          objective: "Review this company close.",
        })
        .pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      yield* organizations.update(organization.id, { expectedRevision: 1, name: "Changed during admission" })
      yield* Deferred.succeed(release, undefined)

      expect(Exit.isFailure(yield* Fiber.await(pending))).toBe(true)
      const stopped = (yield* RayaTaskDelegation.make(database).lookup("dlg_claimed_organization"))!
      expect(stopped.state).toBe("failed")
      expect(stopped.reason).toBe("The organization no longer authorizes this delegation.")
      expect(starts).toEqual([])
      expect(yield* RayaTaskSnapshot.make({ storage }).find(stopped.childRunID ?? "missing")).toBeUndefined()
      expect((yield* runner.tasks.runsFor(books.id)).filter((run) => run.status === "running")).toEqual([])
      expect(yield* storage.list(["raya", "agent-claims"])).toEqual([])
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("a completed manual run releases the worker's next queued delegation", async () => {
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
              return session("ses_queued_after_manual")
            }),
          get: () => Effect.die("unused"),
          messages: () => Effect.succeed([]),
          children: () => Effect.succeed([]),
        },
      })
      const sender = yield* runner.tasks.create({
        name: "Sender",
        objective: "Assign work",
        access: "brief",
        schedule: { kind: "manual" },
      })
      const recipient = yield* runner.tasks.create({
        name: "Recipient",
        objective: "Complete work",
        access: "brief",
        schedule: { kind: "manual" },
      })
      const sid = SessionID.make("ses_manual_busy")
      yield* runner.tasks.record({
        id: "run_manual_busy",
        agentID: recipient.id,
        at: 1,
        sessionID: sid,
        status: "running",
      })
      const queued = yield* runner.delegate({
        source: "dlg_after_manual",
        senderID: sender.id,
        recipientID: recipient.id,
        objective: "Start after the manual review.",
      })
      expect(queued.state).toBe("queued")
      const now = Date.now()
      yield* storage.write(["raya", "goal", sid], {
        objective: "Complete work",
        status: "complete",
        createdAt: now,
        updatedAt: now,
        usage: { turns: 1, continuations: 0, toolCalls: 0 },
        progress: [],
        audit: { summary: "Manual review complete.", verifiedAt: now, requirements: [] },
      })

      yield* runner.settle(sid)
      const started = yield* RayaTaskDelegation.make(database).get(queued.id)
      expect(started.state).toBe("running")
      expect(started.sessionID).toBe(SessionID.make("ses_queued_after_manual"))
      expect(starts).toEqual(["start"])
      expect((yield* runner.tasks.runsFor(recipient.id)).filter((run) => run.status === "running")).toHaveLength(1)
      yield* runner.settle(sid)
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
      expect((yield* runner.tasks.runsFor(books.id)).some(RayaTask.pending)).toBe(false)
      expect((yield* runner.tasks.runsFor(legal.id)).some(RayaTask.pending)).toBe(false)
      expect((yield* runner.tasks.runsFor(books.id)).at(-1)?.blockedReason).toBe("Stopped by the user.")
      expect(yield* runner.tasks.remove(books.id)).toBe(true)
      expect(yield* runner.tasks.remove(legal.id)).toBe(true)
      expect((yield* runner.tasks.get(chief.id)).objective).toBe("Coordinate Friday close.")
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

test("an overdue queued request fails on tick without starting", async () => {
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
              return session(`ses_${starts.length}`)
            }),
          get: () => Effect.die("unused"),
          messages: () => Effect.succeed([]),
          children: () => Effect.succeed([]),
        },
      })
      const store = RayaTaskDelegation.make(database)
      const inbox = RayaTaskInbox.make(database)
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
        source: "dlg_busy",
        senderID: chief.id,
        recipientID: books.id,
        objective: "Finish the open close.",
      })
      expect(first.state).toBe("running")
      const due = Date.now() + 60_000
      const queued = yield* runner.delegate({
        source: "dlg_late",
        senderID: chief.id,
        recipientID: books.id,
        objective: "Review the leftover receipts.",
        deadline: due,
      })
      expect(queued.state).toBe("queued")
      yield* runner.tick(due)
      expect((yield* store.get(queued.id)).state).toBe("failed")
      expect((yield* store.get(queued.id)).reason).toContain("timed out")
      expect((yield* inbox.page(chief.id)).messages.some((item) => item.body.includes("timed out"))).toBe(true)
      expect(starts).toEqual(["start"])
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("an archived or other-folder worker is denied without starting", async () => {
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
              return session(`ses_${starts.length}`)
            }),
          get: () => Effect.die("unused"),
          messages: () => Effect.succeed([]),
          children: () => Effect.succeed([]),
        },
      })
      const inbox = RayaTaskInbox.make(database)
      const chief = yield* runner.tasks.create({
        name: "Chief of Staff",
        role: "generalist",
        objective: "Coordinate Friday close.",
        access: "brief",
        enabled: true,
        dir: "/close",
        schedule: { kind: "manual" },
      })
      const books = yield* runner.tasks.create({
        name: "Accounting",
        role: "accountant",
        objective: "Reconcile receipts.",
        capabilities: ["accounting"],
        access: "full",
        enabled: true,
        dir: "/other",
        schedule: { kind: "manual" },
      })
      const away = yield* runner.delegate({
        source: "dlg_dir",
        senderID: chief.id,
        recipientID: books.id,
        objective: "List missing Friday receipts.",
      })
      expect(away.state).toBe("failed")
      expect(away.reason).toContain("cannot leave the sender's workspace")
      expect(starts).toEqual([])
      expect(yield* runner.tasks.remove(books.id)).toBe(true)
      const gone = yield* runner.delegate({
        source: "dlg_gone",
        senderID: chief.id,
        recipientID: books.id,
        objective: "List missing Friday receipts.",
      })
      expect(gone.state).toBe("failed")
      expect(gone.reason).toContain("no longer available")
      expect(starts).toEqual([])
      expect((yield* inbox.page(chief.id)).messages.filter((item) => item.source.startsWith("reply:")).length).toBe(2)
      expect(
        Exit.isFailure(
          yield* runner
            .delegate({
              source: "dlg_missing",
              senderID: chief.id,
              recipientID: "missing",
              objective: "List missing Friday receipts.",
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("stopping a parent keeps a completed child result", async () => {
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
      const store = RayaTaskDelegation.make(database)
      const inbox = RayaTaskInbox.make(database)
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
        source: "dlg_keep",
        senderID: chief.id,
        recipientID: books.id,
        objective: "List missing Friday receipts.",
      })
      const child = yield* runner.delegate({
        source: "dlg_keep_child",
        senderID: books.id,
        recipientID: legal.id,
        parentID: parent.id,
        objective: "Confirm the missing receipts against policy.",
      })
      const kept = yield* store.finish(child.id, "completed", legal, "Named missing receipts.")
      expect(kept.state).toBe("completed")
      const run = (yield* runner.tasks.runsFor(legal.id)).at(-1)
      expect(run).toBeDefined()
      yield* runner.tasks.transition(run!, {
        ...run!,
        status: "complete",
        outcome: { kind: "notify", summary: "Named missing receipts.", cost: 0 },
      })
      const stopped = yield* runner.stop(parent.id)
      expect(stopped.state).toBe("cancelled")
      expect((yield* store.get(child.id)).state).toBe("completed")
      expect((yield* store.get(child.id)).response).toBe("Named missing receipts.")
      expect(halted).toEqual([parent.sessionID!])
      expect((yield* inbox.page(books.id)).messages.filter((item) => item.source.startsWith("reply:")).length).toBe(1)
      expect((yield* runner.tasks.runsFor(legal.id)).at(-1)?.status).toBe("complete")
      expect((yield* runner.tasks.runsFor(legal.id)).some(RayaTask.pending)).toBe(false)
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})
