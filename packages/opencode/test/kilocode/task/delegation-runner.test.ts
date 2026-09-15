import { expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { sql } from "drizzle-orm"
import { createHash } from "node:crypto"
import { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import { RayaTask } from "@/kilocode/task"
import { RayaTaskDelegation, ceiling } from "@/kilocode/task/delegation"
import { RayaTaskInbox } from "@/kilocode/task/inbox"
import { RayaTaskOrganization } from "@/kilocode/task/organization"
import { RayaTaskRunner } from "@/kilocode/task/runner"
import { RayaTaskSnapshot } from "@/kilocode/task/snapshot"
import { RayaGoal } from "@/kilocode/goal"
import { owner } from "@/kilocode/task/owner"

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
          return base
            .create(key, value)
            .pipe(
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

test("organization policy is pinned at authorization and cannot widen delegated permissions", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const storage = memory()
      const calls: Array<{ permission: unknown }> = []
      const state = { id: "", updated: false }
      const runner = RayaTaskRunner.make({
        database,
        storage,
        sessions: {
          create: (input) =>
            Effect.gen(function* () {
              if (!input) return yield* Effect.die(new Error("Expected delegated session input"))
              if (!state.updated) {
                state.updated = true
                yield* organizations.update(state.id, {
                  expectedRevision: 1,
                  policy: "Use the later policy.",
                })
              }
              calls.push({ permission: input.permission })
              return session("ses_policy")
            }).pipe(Effect.orDie),
          get: () => Effect.die("unused"),
          messages: () => Effect.succeed([]),
          children: () => Effect.succeed([]),
        },
      })
      const chief = yield* runner.tasks.create({
        name: "Chief",
        objective: "Assign work",
        access: "full",
        tools: ["read", "bash"],
        schedule: { kind: "manual" },
      })
      const books = yield* runner.tasks.create({
        name: "Books",
        objective: "Review accounts",
        access: "full",
        tools: ["read", "write"],
        schedule: { kind: "manual" },
      })
      const organizations = RayaTaskOrganization.make(database, runner.tasks, storage)
      const text = "Cite café receipts exactly.\nNever infer a missing total."
      const organization = yield* organizations.create({
        name: "Company",
        policy: text,
        members: [
          { agentID: chief.id, role: "Chief" },
          { agentID: books.id, role: "Books" },
        ],
        delegations: [{ senderID: chief.id, recipientID: books.id }],
      })
      state.id = organization.id
      const row = yield* runner.delegate({
        source: "dlg_policy",
        senderID: chief.id,
        recipientID: books.id,
        organizationID: organization.id,
        organizationRevision: organization.revision,
        objective: "Review the close.",
      })
      expect(row.state).toBe("running")
      expect((yield* organizations.get(organization.id)).revision).toBe(2)
      const saved = yield* RayaTaskSnapshot.make({ storage }).get(row.childRunID!)
      expect(saved.version).toBe(2)
      if (saved.version !== 2) return yield* Effect.die("Expected a current startup snapshot")
      expect(saved.objective.split(text)).toHaveLength(2)
      expect(saved.objective).not.toContain("Use the later policy.")
      expect(saved.organizationPolicy).toEqual({
        organizationID: organization.id,
        organizationRevision: 1,
        sha256: createHash("sha256").update(text, "utf8").digest("hex"),
      })
      expect(calls[0]?.permission).toEqual(RayaTask.rules(ceiling(chief, books)))
      expect(calls[0]?.permission).not.toEqual(RayaTask.rules(books))
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("a durable removal owner refuses concurrent delegation admission", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const base = memory()
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const storage = {
        ...base,
        create: (key: string[], value: unknown) => {
          const operation = value && typeof value === "object" && "operation" in value ? value.operation : undefined
          return base
            .create(key, value)
            .pipe(
              Effect.tap((created) =>
                created && key[1] === "agent-claims" && operation === "remove"
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
              return session("ses_removal_race")
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
        objective: "Review accounts",
        access: "brief",
        schedule: { kind: "manual" },
      })
      const removal = yield* runner.tasks.remove(books.id).pipe(Effect.forkChild)
      yield* Deferred.await(entered)

      const denied = yield* runner
        .delegate({
          source: "dlg_removal_race",
          senderID: chief.id,
          recipientID: books.id,
          objective: "Review the close.",
        })
        .pipe(Effect.flip)
      expect(denied._tag).toBe("RayaTask.GuardError")
      expect(denied.message).toContain("being removed")
      expect(yield* RayaTaskDelegation.make(database).lookup("dlg_removal_race")).toBeUndefined()
      expect(starts).toEqual([])

      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(removal)).toBe(true)
      expect(Exit.isFailure(yield* runner.tasks.get(books.id).pipe(Effect.exit))).toBe(true)
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("restart resumes an accepted delegation that stopped before its startup claim", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const storage = memory()
      const opened: Array<ReturnType<typeof session> & { metadata?: Record<string, unknown> }> = []
      const runner = RayaTaskRunner.make({
        database,
        storage,
        sessions: {
          create: (value) =>
            Effect.sync(() => {
              const created = { ...session("ses_restart_accepted"), metadata: value?.metadata }
              opened.push(created)
              return created
            }),
          get: (id) => Effect.sync(() => opened.find((item) => item.id === id)!),
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
        objective: "Review accounts",
        access: "brief",
        schedule: { kind: "manual" },
      })
      const store = RayaTaskDelegation.make(database)
      const admitted = yield* store.admit(
        {
          source: "dlg_restart_before_claim",
          senderID: chief.id,
          recipientID: books.id,
          objective: "Review the close.",
        },
        chief,
        books,
      )
      const taken = (yield* store.take(books.id))!
      expect(taken.state).toBe("accepted")
      expect(taken.childRunID).toBeString()
      expect(opened).toHaveLength(0)

      yield* runner.revive()

      const running = yield* store.get(admitted.record.id)
      expect(running).toMatchObject({
        state: "running",
        childRunID: taken.childRunID,
        sessionID: SessionID.make("ses_restart_accepted"),
      })
      expect(opened).toHaveLength(1)
      expect((yield* runner.tasks.runsFor(books.id)).filter((run) => run.id === taken.childRunID)).toHaveLength(1)
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("restart attaches the exact saved run when delegation attachment was interrupted", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const storage = memory()
      const opened: Array<ReturnType<typeof session> & { metadata?: Record<string, unknown> }> = []
      const sessions = {
        create: (value?: { metadata?: Record<string, unknown> }) =>
          Effect.sync(() => {
            const created = { ...session("ses_restart_attach"), metadata: value?.metadata }
            opened.push(created)
            return created
          }),
        get: (id: SessionID) => Effect.sync(() => opened.find((item) => item.id === id)!),
        messages: () => Effect.succeed([]),
        children: () => Effect.succeed([]),
      }
      const runner = RayaTaskRunner.make({ database, storage, sessions })
      const chief = yield* runner.tasks.create({
        name: "Chief",
        objective: "Assign work",
        access: "brief",
        schedule: { kind: "manual" },
      })
      const books = yield* runner.tasks.create({
        name: "Books",
        objective: "Review accounts",
        access: "brief",
        schedule: { kind: "manual" },
      })
      yield* database.db.run(`
        CREATE TRIGGER fail_delegation_attach
        BEFORE UPDATE ON raya_routine_delegation
        WHEN OLD.state = 'accepted' AND NEW.state = 'running'
        BEGIN
          SELECT RAISE(ABORT, 'injected attachment failure');
        END
      `)
      const failed = yield* runner
        .delegate({
          source: "dlg_restart_attach",
          senderID: chief.id,
          recipientID: books.id,
          objective: "Review the close.",
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(failed)).toBe(true)
      const store = RayaTaskDelegation.make(database)
      const accepted = (yield* store.lookup("dlg_restart_attach"))!
      expect(accepted.state).toBe("accepted")
      expect(opened).toHaveLength(1)
      expect((yield* runner.tasks.runsFor(books.id)).filter((run) => run.id === accepted.childRunID)).toHaveLength(1)
      yield* database.db.run("DROP TRIGGER fail_delegation_attach")

      yield* RayaTaskRunner.make({ database, storage, sessions }).revive()

      const running = yield* store.get(accepted.id)
      expect(running).toMatchObject({
        state: "running",
        childRunID: accepted.childRunID,
        sessionID: SessionID.make("ses_restart_attach"),
      })
      expect(opened).toHaveLength(1)
      expect((yield* runner.tasks.runsFor(books.id)).filter((run) => run.id === accepted.childRunID)).toHaveLength(1)
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("restart recovers the exact delegation session when history was not recorded", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const storage = memory()
      const runner = RayaTaskRunner.make({
        database,
        storage,
        sessions: {
          create: () => Effect.die("must not create a second session"),
          get: () => Effect.die("installed below"),
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
        objective: "Review accounts",
        access: "brief",
        schedule: { kind: "manual" },
      })
      const store = RayaTaskDelegation.make(database)
      const admitted = yield* store.admit(
        {
          source: "dlg_restart_session",
          senderID: chief.id,
          recipientID: books.id,
          objective: "Review the close.",
        },
        chief,
        books,
      )
      const taken = (yield* store.take(books.id))!
      const at = Date.now()
      const sid = SessionID.make("ses_restart_session")
      const trigger = { kind: "manual" as const }
      const metadata = {
        rayaRoutine: {
          version: 1 as const,
          agentID: books.id,
          runID: taken.childRunID!,
          scheduleVersion: 1,
          trigger,
          delegationID: taken.id,
        },
      }
      const saved = { ...session(sid), metadata }
      yield* database.db.run(
        sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES (${saved.projectID}, ${saved.directory}, ${JSON.stringify([])}, ${at}, ${at})`,
      )
      yield* database.db.run(
        sql`INSERT INTO session (id, project_id, slug, directory, title, version, metadata, time_created, time_updated) VALUES (${sid}, ${saved.projectID}, ${saved.slug}, ${saved.directory}, ${saved.title}, ${saved.version}, ${JSON.stringify(metadata)}, ${at}, ${at})`,
      )
      const key = ["raya", "agent-claims", createHash("sha256").update(books.id).digest("hex")]
      yield* storage.replace(key, {
        version: 1,
        agentID: books.id,
        id: taken.childRunID,
        at,
        phase: "claimed",
        owner: { ...owner(), pid: 2_147_483_647 },
        trigger,
        delegationID: taken.id,
      })
      const sessions = {
        create: () => Effect.die("must not create a second session"),
        get: (id: SessionID) => Effect.sync(() => (id === sid ? saved : undefined)!),
        messages: () => Effect.succeed([]),
        children: () => Effect.succeed([]),
      }
      yield* RayaGoal.make({ storage, sessions }).create(sid, "Review the close.")

      yield* RayaTaskRunner.make({ database, storage, sessions }).revive()

      expect(yield* store.get(admitted.record.id)).toMatchObject({
        state: "running",
        childRunID: taken.childRunID,
        sessionID: sid,
      })
      expect((yield* runner.tasks.runsFor(books.id)).filter((run) => run.id === taken.childRunID)).toHaveLength(1)
      expect(yield* storage.list(["raya", "agent-claims"])).toEqual([])
      expect((yield* database.db.select().from(SessionTable).all()).filter((row) => row.id === sid)).toHaveLength(1)
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

test("settlement replay restores one report and releases one queued delegation", async () => {
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
              const id = `ses_settlement_replay_${starts.length + 1}`
              starts.push(id)
              return session(id)
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
        objective: "Review accounts",
        access: "brief",
        schedule: { kind: "manual" },
      })
      const first = yield* runner.delegate({
        source: "dlg_settlement_first",
        senderID: chief.id,
        recipientID: books.id,
        objective: "Review the first close.",
      })
      const second = yield* runner.delegate({
        source: "dlg_settlement_second",
        senderID: chief.id,
        recipientID: books.id,
        objective: "Review the next close.",
      })
      expect(first.state).toBe("running")
      expect(second.state).toBe("queued")
      const now = Date.now()
      yield* storage.write(["raya", "goal", first.sessionID!], {
        objective: "Review the first close.",
        status: "complete",
        createdAt: now,
        updatedAt: now,
        usage: { turns: 1, continuations: 0, toolCalls: 0 },
        progress: [],
        audit: { summary: "The first close is reconciled.", verifiedAt: now, requirements: [] },
      })
      yield* database.db.run(`
        CREATE TRIGGER fail_settlement_finish
        BEFORE UPDATE ON raya_routine_delegation
        WHEN OLD.state = 'running' AND NEW.state = 'completed'
        BEGIN
          SELECT RAISE(ABORT, 'injected delegation finish failure');
        END
      `)

      expect(Exit.isFailure(yield* runner.settle(first.sessionID!).pipe(Effect.exit))).toBe(true)
      const store = RayaTaskDelegation.make(database)
      const inbox = RayaTaskInbox.make(database)
      expect((yield* runner.tasks.runsFor(books.id)).find((run) => run.id === first.childRunID)?.status).toBe(
        "complete",
      )
      expect((yield* store.get(first.id)).state).toBe("running")
      expect(
        (yield* inbox.page(books.id)).messages.filter((item) => item.source === `report:${first.childRunID}`),
      ).toHaveLength(1)
      yield* database.db.run("DROP TRIGGER fail_settlement_finish")
      yield* database.db.run(`
        CREATE TRIGGER fail_next_acceptance
        BEFORE UPDATE ON raya_routine_delegation
        WHEN OLD.state = 'queued' AND NEW.state = 'accepted'
        BEGIN
          SELECT RAISE(ABORT, 'injected next acceptance failure');
        END
      `)

      expect(Exit.isFailure(yield* runner.settle(first.sessionID!).pipe(Effect.exit))).toBe(true)
      expect((yield* store.get(first.id)).state).toBe("completed")
      expect((yield* store.get(second.id)).state).toBe("queued")
      expect((yield* inbox.page(chief.id)).messages.filter((item) => item.source.startsWith("reply:"))).toHaveLength(1)
      expect(
        (yield* inbox.page(books.id)).messages.filter((item) => item.source === `report:${first.childRunID}`),
      ).toHaveLength(1)
      expect(starts).toEqual(["ses_settlement_replay_1"])
      yield* database.db.run("DROP TRIGGER fail_next_acceptance")

      yield* runner.settle(first.sessionID!)
      yield* runner.settle(first.sessionID!)

      const running = yield* store.get(second.id)
      expect(running.state).toBe("running")
      expect(starts).toEqual(["ses_settlement_replay_1", "ses_settlement_replay_2"])
      expect((yield* runner.tasks.runsFor(books.id)).filter((run) => run.id === running.childRunID)).toHaveLength(1)
      expect((yield* inbox.page(chief.id)).messages.filter((item) => item.source.startsWith("reply:"))).toHaveLength(1)
      expect(
        (yield* inbox.page(books.id)).messages.filter((item) => item.source === `report:${first.childRunID}`),
      ).toHaveLength(1)
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("waiting for the user survives restart and holds the next delegation", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const storage = memory()
      const starts: string[] = []
      const halted: string[] = []
      const sessions = {
        create: () =>
          Effect.sync(() => {
            const id = `ses_wait_restart_${starts.length + 1}`
            starts.push(id)
            return session(id)
          }),
        get: () => Effect.die("unused"),
        messages: () => Effect.succeed([]),
        children: () => Effect.succeed([]),
      }
      const input = {
        database,
        storage,
        sessions,
        halt: (id: SessionID) =>
          Effect.sync(() => {
            halted.push(id)
          }),
      }
      const runner = RayaTaskRunner.make(input)
      const chief = yield* runner.tasks.create({
        name: "Chief",
        objective: "Assign work",
        access: "brief",
        schedule: { kind: "manual" },
      })
      const books = yield* runner.tasks.create({
        name: "Books",
        objective: "Review accounts",
        access: "brief",
        schedule: { kind: "manual" },
      })
      const first = yield* runner.delegate({
        source: "dlg_wait_first",
        senderID: chief.id,
        recipientID: books.id,
        objective: "Ask which ledger to use.",
      })
      const second = yield* runner.delegate({
        source: "dlg_wait_second",
        senderID: chief.id,
        recipientID: books.id,
        objective: "Review the next close.",
      })
      expect(first.state).toBe("running")
      expect(second.state).toBe("queued")
      if (!first.sessionID) throw new Error("Expected first delegated session")
      const firstSessionID = first.sessionID

      yield* runner.park(firstSessionID, true)
      yield* runner.settle(firstSessionID)
      const store = RayaTaskDelegation.make(database)
      expect(yield* store.get(first.id)).toMatchObject({ state: "needs_input", sessionID: first.sessionID })
      expect((yield* runner.tasks.runsFor(books.id)).find((run) => run.id === first.childRunID)).toMatchObject({
        status: "blocked",
        blockedReason: "waiting on you",
      })

      const reopened = RayaTaskRunner.make(input)
      yield* reopened.revive()
      yield* reopened.revive()

      expect((yield* store.get(second.id)).state).toBe("queued")
      expect(starts).toEqual(["ses_wait_restart_1"])
      expect((yield* reopened.tasks.runsFor(books.id)).filter(RayaTask.pending)).toHaveLength(1)

      const resumed = yield* reopened.ask(books.id, "Use the general ledger.", { defer: true })
      expect(resumed).toMatchObject({ id: first.childRunID, sessionID: first.sessionID, status: "blocked" })
      expect((yield* reopened.tasks.runsFor(books.id)).find((run) => run.id === first.childRunID)?.status).toBe(
        "running",
      )
      expect(yield* store.get(first.id)).toMatchObject({ state: "running", sessionID: first.sessionID })
      expect((yield* store.get(second.id)).state).toBe("queued")
      expect(starts).toEqual(["ses_wait_restart_1"])

      expect((yield* reopened.stop(first.id)).state).toBe("cancelled")
      const running = yield* store.get(second.id)
      expect(running.state).toBe("running")
      expect(starts).toEqual(["ses_wait_restart_1", "ses_wait_restart_2"])
      expect(halted).toEqual([firstSessionID])
      expect((yield* reopened.tasks.runsFor(books.id)).filter((run) => run.id === running.childRunID)).toHaveLength(1)
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

test("late settlement cannot replace cancellation or alter the recipient's next run", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const storage = memory()
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const starts: string[] = []
      const runner = RayaTaskRunner.make({
        database,
        storage,
        halt: () => Effect.void,
        sessions: {
          create: () =>
            Effect.sync(() => {
              const id = `ses_late_${starts.length + 1}`
              starts.push(id)
              return session(id)
            }),
          get: () => Effect.die("unused"),
          messages: ({ sessionID }) =>
            sessionID === SessionID.make("ses_late_1")
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as([]))
              : Effect.succeed([]),
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
        objective: "Review accounts",
        access: "brief",
        schedule: { kind: "manual" },
      })
      const first = yield* runner.delegate({
        source: "dlg_late_first",
        senderID: chief.id,
        recipientID: books.id,
        objective: "Review the first close.",
      })
      const now = Date.now()
      yield* storage.write(["raya", "goal", first.sessionID!], {
        objective: "Review the first close.",
        status: "complete",
        createdAt: now,
        updatedAt: now,
        usage: { turns: 1, continuations: 0, toolCalls: 0 },
        progress: [],
        audit: { summary: "The stale close says complete.", verifiedAt: now, requirements: [] },
      })
      const settling = yield* runner.settle(first.sessionID!).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      expect((yield* runner.stop(first.id)).state).toBe("cancelled")
      const second = yield* runner.delegate({
        source: "dlg_late_second",
        senderID: chief.id,
        recipientID: books.id,
        objective: "Review the current close.",
      })
      expect(second.state).toBe("running")
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(settling)

      const store = RayaTaskDelegation.make(database)
      expect((yield* store.get(first.id)).state).toBe("cancelled")
      expect((yield* store.get(first.id)).response).toBeUndefined()
      expect((yield* store.get(second.id)).state).toBe("running")
      expect(starts).toEqual(["ses_late_1", "ses_late_2"])
      const runs = yield* runner.tasks.runsFor(books.id)
      expect(runs.find((run) => run.id === first.childRunID)?.status).toBe("error")
      expect(runs.find((run) => run.id === second.childRunID)?.status).toBe("running")
      const replies = (yield* RayaTaskInbox.make(database).page(chief.id)).messages.filter((item) =>
        item.source.startsWith("reply:"),
      )
      expect(replies.filter((item) => item.body.includes("The stale close says complete."))).toEqual([])
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
