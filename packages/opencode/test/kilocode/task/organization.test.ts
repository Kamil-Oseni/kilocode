import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { eq, sql } from "drizzle-orm"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import {
  RayaRoutineDelegationTable as Delegation,
  RayaRoutineOrganizationRevisionTable as Revision,
} from "@opencode-ai/core/kilocode/routine.sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { RayaTask } from "@/kilocode/task"
import { archive as indexed } from "@/kilocode/task/archive"
import { RayaTaskDelegation } from "@/kilocode/task/delegation"
import { RayaTaskInbox } from "@/kilocode/task/inbox"
import { Conflict, RayaTaskOrganization } from "@/kilocode/task/organization"
import { RayaTaskQueue } from "@/kilocode/task/queue"
import { RayaTaskRunner } from "@/kilocode/task/runner"
import { claim } from "@/kilocode/task/claim"
import { owner } from "@/kilocode/task/owner"
import { SessionID } from "@/session/schema"
import { InstanceStore } from "@/project/instance-store"
import { Storage } from "@/storage/storage"

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
    replace: (key: string[], value: unknown) => Effect.sync(() => data.set(key.join("/"), value)).pipe(Effect.asVoid),
    read<T>(key: string[]) {
      const value = data.get(key.join("/"))
      return value === undefined
        ? Effect.fail(new Storage.NotFoundError({ message: "missing" }))
        : Effect.succeed(value as T)
    },
    write: (key: string[], value: unknown) => Effect.sync(() => data.set(key.join("/"), value)).pipe(Effect.asVoid),
    remove: (key: string[]) => Effect.sync(() => data.delete(key.join("/"))).pipe(Effect.asVoid),
    update<T>(key: string[], fn: (draft: T) => void) {
      return Effect.sync(() => {
        const value = data.get(key.join("/")) as T
        fn(value)
        data.set(key.join("/"), value)
        return value
      })
    },
    list: (prefix: string[]) => {
      const start = prefix.join("/")
      return Effect.succeed([...data.keys()].filter((key) => key.startsWith(start)).map((key) => key.split("/")))
    },
  }
}

test("routine organizations persist ordered versioned graphs and preserve archived conversations", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const storage = memory()
      const tasks = RayaTask.make({ storage, database })
      const organizations = RayaTaskOrganization.make(database, tasks, storage)
      const inbox = RayaTaskInbox.make(database)
      const chief = yield* tasks.create({
        name: "Chief",
        role: "generalist",
        objective: "Coordinate the company",
        schedule: { kind: "manual" },
      })
      const books = yield* tasks.create({
        name: "Books",
        role: "accountant",
        objective: "Review accounts",
        capabilities: ["accounting"],
        schedule: { kind: "manual" },
      })
      const design = yield* tasks.create({
        name: "Design",
        role: "designer",
        objective: "Design sites",
        schedule: { kind: "manual" },
      })
      yield* inbox.publish({ agentID: books.id, source: "report:close", kind: "report", body: "Close retained." })
      const created = yield* organizations.create({
        name: "Website Builders",
        purpose: "Build and operate client websites.",
        policy: "Cite the source for every client claim.",
        budget: 500,
        members: [
          { agentID: chief.id, role: "CEO" },
          { agentID: books.id, role: "Accounting", supervisorID: chief.id },
          { agentID: design.id, role: "Chief Designer", supervisorID: chief.id },
        ],
        delegations: [
          { senderID: chief.id, recipientID: books.id },
          { senderID: chief.id, recipientID: design.id },
        ],
      })
      expect(created.id).toMatch(/^org_[a-f0-9]{32}$/)
      expect(created.revision).toBe(1)
      expect(created.members.map((member) => member.position)).toEqual([0, 1, 2])
      expect(created.delegations.map((edge) => edge.position)).toEqual([0, 1])
      expect(
        yield* organizations.authorize({
          id: created.id,
          revision: 1,
          senderID: chief.id,
          recipientID: books.id,
        }),
      ).toEqual({
        id: created.id,
        name: "Website Builders",
        revision: 1,
        policy: "Cite the source for every client claim.",
        budget: 500,
      })
      expect(
        Exit.isFailure(
          yield* organizations
            .authorize({ id: created.id, revision: 1, senderID: books.id, recipientID: chief.id })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(yield* organizations.hasActive(books.id)).toBe(true)
      expect(yield* organizations.contains(created.id, [chief.id, books.id])).toBe(true)
      expect(yield* organizations.contains(created.id, [chief.id, "missing"])).toBe(false)
      expect(yield* organizations.shares(chief.id, books.id)).toBe(true)
      expect(yield* organizations.shares(books.id, design.id)).toBe(true)
      expect(Exit.isFailure(yield* tasks.remove(books.id).pipe(Effect.exit))).toBe(true)

      const updated = yield* organizations.update(created.id, {
        expectedRevision: 1,
        purpose: null,
        policy: null,
        budget: null,
        members: [
          { agentID: chief.id, role: "CEO" },
          { agentID: design.id, role: "Design", supervisorID: chief.id },
          { agentID: books.id, role: "Finance", supervisorID: chief.id },
        ],
        delegations: [{ senderID: chief.id, recipientID: design.id }],
      })
      expect(updated.revision).toBe(2)
      expect(updated.purpose).toBeUndefined()
      expect(updated.policy).toBeUndefined()
      expect(updated.budget).toBeUndefined()
      expect(updated.members.map((member) => member.agentID)).toEqual([chief.id, design.id, books.id])
      expect(updated.delegations).toEqual([{ senderID: chief.id, recipientID: design.id, position: 0 }])
      expect(
        Exit.isFailure(
          yield* organizations
            .authorize({ id: created.id, revision: 1, senderID: chief.id, recipientID: design.id })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(
        Exit.isFailure(
          yield* organizations.update(created.id, { expectedRevision: 1, name: "Stale" }).pipe(Effect.exit),
        ),
      ).toBe(true)
      const revisions = yield* database.db.select().from(Revision).where(eq(Revision.organization_id, created.id)).all()
      expect(revisions.map((row) => row.revision)).toEqual([1, 2])
      expect(JSON.parse(revisions[0]!.definition).members[1].role).toBe("Accounting")
      expect(JSON.parse(revisions[0]!.definition).policy).toBe("Cite the source for every client claim.")
      expect(JSON.parse(revisions[0]!.definition).budget).toBe(500)

      const restarted = RayaTaskOrganization.make(database, tasks, storage)
      expect((yield* restarted.get(created.id)).policy).toBeUndefined()
      expect((yield* restarted.get(created.id)).budget).toBeUndefined()

      expect(Exit.isFailure(yield* organizations.archive(created.id, { expectedRevision: 2 }).pipe(Effect.exit))).toBe(
        true,
      )
      for (const member of updated.members) yield* tasks.update(member.agentID, { enabled: false })
      const run = yield* tasks.record({
        id: "run_archive_guard",
        agentID: chief.id,
        sessionID: SessionID.make("ses_archive_guard"),
        at: Date.now(),
        status: "running",
      })
      expect(Exit.isFailure(yield* organizations.archive(created.id, { expectedRevision: 2 }).pipe(Effect.exit))).toBe(
        true,
      )
      yield* tasks.transition(run, { ...run, status: "error", blockedReason: "Stopped." })
      const archived = yield* organizations.archive(created.id, { expectedRevision: 2 })
      expect(archived).toMatchObject({ archived: true, revision: 3 })
      expect((yield* organizations.list()).items).toEqual([])
      expect(yield* organizations.shares(chief.id, books.id)).toBe(false)
      expect((yield* organizations.list({ archived: true })).items[0]?.id).toBe(created.id)
      expect((yield* organizations.get(created.id)).members).toEqual(archived.members)
      expect((yield* inbox.page(books.id)).messages[0]?.body).toBe("Close retained.")
      expect(yield* tasks.remove(books.id)).toBe(true)
      expect((yield* organizations.get(created.id)).members.some((member) => member.agentID === books.id)).toBe(true)
      expect(yield* database.db.get(sql`SELECT count(*) AS count FROM raya_routine_organization_revision`)).toEqual({
        count: 3,
      })
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("organization policy is bounded and clearing it is an explicit revisioned change", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const storage = memory()
      const tasks = RayaTask.make({ storage, database })
      const organizations = RayaTaskOrganization.make(database, tasks, storage)
      const worker = yield* tasks.create({ name: "Worker", objective: "Work", schedule: { kind: "manual" } })
      expect(
        Exit.isFailure(
          yield* organizations
            .create({ name: "Oversize", policy: "x".repeat(12_001), members: [{ agentID: worker.id, role: "Owner" }] })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      const item = yield* organizations.create({
        name: "Bounded",
        policy: "x".repeat(12_000),
        members: [{ agentID: worker.id, role: "Owner" }],
      })
      expect(item.policy?.length).toBe(12_000)
      expect(
        Exit.isFailure(
          yield* organizations.update(item.id, { expectedRevision: 1, policy: "x".repeat(12_001) }).pipe(Effect.exit),
        ),
      ).toBe(true)
      const blank = yield* organizations.update(item.id, { expectedRevision: 1, policy: "   " })
      expect(blank).toMatchObject({ revision: 2 })
      expect(blank.policy).toBeUndefined()
      const restored = yield* organizations.update(item.id, { expectedRevision: 2, policy: "Require proof." })
      const cleared = yield* organizations.update(item.id, { expectedRevision: restored.revision, policy: null })
      expect(cleared).toMatchObject({ revision: 4 })
      expect(cleared.policy).toBeUndefined()
      expect((yield* RayaTaskOrganization.make(database, tasks, storage).get(item.id)).policy).toBeUndefined()
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("organization budget cannot undercut committed work and zero clears it", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const storage = memory()
      const tasks = RayaTask.make({ storage, database })
      const organizations = RayaTaskOrganization.make(database, tasks, storage)
      const chief = yield* tasks.create({ name: "Chief", objective: "Lead", schedule: { kind: "manual" } })
      const books = yield* tasks.create({ name: "Books", objective: "Review", schedule: { kind: "manual" } })
      const item = yield* organizations.create({
        name: "Bounded",
        budget: 20,
        members: [
          { agentID: chief.id, role: "Chief" },
          { agentID: books.id, role: "Books" },
        ],
        delegations: [{ senderID: chief.id, recipientID: books.id }],
      })
      const project = ProjectV2.ID.make("project_organization_budget")
      yield* database.db.insert(ProjectTable).values({
        id: project,
        worktree: AbsolutePath.make("/workspace"),
        sandboxes: [],
        time_created: 1,
        time_updated: 1,
      })
      yield* database.db.insert(SessionTable).values({
        id: SessionID.make("ses_organization_direct_cost"),
        project_id: project,
        slug: "organization-direct-cost",
        directory: AbsolutePath.make("/workspace"),
        title: "Organization direct cost",
        version: "test",
        cost: 3,
        metadata: { rayaRoutine: { organizationID: item.id } },
        time_created: 1,
        time_updated: 1,
      })
      const work = RayaTaskDelegation.make(database, organizations.authorize, organizations.shares)
      yield* work.admit(
        {
          source: "org_budget_commitment",
          senderID: chief.id,
          recipientID: books.id,
          organizationID: item.id,
          organizationRevision: item.revision,
          objective: "Review the books.",
          budget: 12,
        },
        chief,
        books,
      )
      const low = yield* organizations.update(item.id, { expectedRevision: 1, budget: 14 }).pipe(Effect.flip)
      expect(low.message).toContain("cannot be lower than its current committed model cost")
      const exact = yield* organizations.update(item.id, { expectedRevision: 1, budget: 15 })
      expect(exact).toMatchObject({ revision: 2, budget: 15 })
      const cleared = yield* organizations.update(item.id, { expectedRevision: 2, budget: 0 })
      expect(cleared).toMatchObject({ revision: 3 })
      expect(cleared.budget).toBeUndefined()
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("routine organizations reject invalid membership and supervisor graphs", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const storage = memory()
      const tasks = RayaTask.make({ storage, database })
      const organizations = RayaTaskOrganization.make(database, tasks, storage)
      const one = yield* tasks.create({ name: "One", objective: "One", schedule: { kind: "manual" } })
      const two = yield* tasks.create({ name: "Two", objective: "Two", schedule: { kind: "manual" } })
      const invalid = [
        [
          { agentID: one.id, role: "Lead" },
          { agentID: one.id, role: "Duplicate" },
        ],
        [{ agentID: one.id, role: "Lead", supervisorID: one.id }],
        [{ agentID: one.id, role: "Lead", supervisorID: "missing" }],
        [
          { agentID: one.id, role: "One", supervisorID: two.id },
          { agentID: two.id, role: "Two", supervisorID: one.id },
        ],
        [{ agentID: "missing", role: "Missing" }],
      ]
      for (const members of invalid) {
        const result = yield* organizations.create({ name: "Invalid", members }).pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
      }
      const edges = [
        [{ senderID: one.id, recipientID: one.id }],
        [{ senderID: one.id, recipientID: "missing" }],
        [
          { senderID: one.id, recipientID: two.id },
          { senderID: one.id, recipientID: two.id },
        ],
      ]
      for (const delegations of edges) {
        const result = yield* organizations
          .create({
            name: "Invalid edge",
            members: [
              { agentID: one.id, role: "One" },
              { agentID: two.id, role: "Two" },
            ],
            delegations,
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
      }
      expect((yield* organizations.list()).items).toEqual([])
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("organization provisioning replays only the exact saved definition", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const storage = memory()
      const tasks = RayaTask.make({ storage, database })
      const worker = yield* tasks.create({ name: "Worker", objective: "Work", schedule: { kind: "manual" } })
      const input = {
        name: "Operations",
        purpose: "Run the company.",
        members: [{ agentID: worker.id, role: "Owner" }],
        delegations: [],
      }
      const id = `org_${"1".repeat(32)}`
      const created = yield* RayaTaskOrganization.make(database, tasks, storage).provision(input, id)
      const restarted = RayaTaskOrganization.make(database, tasks, storage)
      expect(yield* restarted.provision(input, id)).toEqual(created)

      const changed = yield* restarted.provision({ ...input, purpose: "Replace the company." }, id).pipe(Effect.flip)
      expect(changed).toEqual(new Conflict({ message: "An organization already uses this ID with different details." }))
      expect(yield* restarted.get(id)).toEqual(created)
      expect((yield* restarted.list()).items.filter((item) => item.id === id)).toHaveLength(1)
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("organization usage retains removed and archived membership history", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const storage = memory()
      const tasks = RayaTask.make({ storage, database })
      const organizations = RayaTaskOrganization.make(database, tasks, storage)
      const owner = yield* tasks.create({ name: "Owner", objective: "Lead", schedule: { kind: "manual" } })
      const former = yield* tasks.create({ name: "Former", objective: "Work", schedule: { kind: "manual" } })
      expect(yield* organizations.used(former.id)).toEqual({ used: false, complete: true })
      const organization = yield* organizations.create({
        name: "History",
        members: [
          { agentID: owner.id, role: "Owner" },
          { agentID: former.id, role: "Former" },
        ],
      })
      yield* organizations.update(organization.id, {
        expectedRevision: 1,
        members: [{ agentID: owner.id, role: "Owner" }],
      })
      expect((yield* organizations.memberships(former.id)).items).toEqual([])
      expect(yield* organizations.used(former.id)).toEqual({ used: true, complete: true })
      yield* tasks.update(owner.id, { enabled: false })
      yield* organizations.archive(organization.id, { expectedRevision: 2 })
      expect(yield* organizations.used(owner.id)).toEqual({ used: true, complete: true })
      yield* database.db
        .update(Revision)
        .set({ definition: "not-json" })
        .where(eq(Revision.organization_id, organization.id))
        .run()
      expect(yield* organizations.used("unused")).toEqual({ used: false, complete: false })
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("interrupted organization stop stays visible and fenced until a retry completes", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const storage = memory()
      const tasks = RayaTask.make({ storage, database })
      const worker = yield* tasks.create({ name: "Worker", objective: "Work", schedule: { kind: "manual" } })
      const organizations = RayaTaskOrganization.make(database, tasks, storage)
      const item = yield* organizations.create({ name: "Team", members: [{ agentID: worker.id, role: "Worker" }] })
      const failed = RayaTaskOrganization.make(
        database,
        {
          ...tasks,
          stop: () =>
            Effect.gen(function* () {
              yield* tasks.update(worker.id, { enabled: false })
              return yield* Effect.die("stop interrupted")
            }),
        },
        storage,
      )
      expect(Exit.isFailure(yield* failed.archive(item.id, { expectedRevision: 1 }).pipe(Effect.exit))).toBe(true)
      expect((yield* organizations.list()).items.map((entry) => entry.id)).toContain(item.id)
      expect((yield* failed.pending()).map((entry) => entry.id)).toContain(item.id)
      expect(yield* failed.stopped(worker.id)).toBe(true)
      const resumed = RayaTaskOrganization.make(database, { ...tasks, stop: () => Effect.void }, storage)
      expect((yield* resumed.archive(item.id, { expectedRevision: 1 })).archived).toBe(true)
      expect(yield* resumed.pending()).toEqual([])
      expect(yield* resumed.stopped(worker.id)).toBe(true)
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("restart finishes a stopped scheduled worker after an in-flight start clears", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const storage = memory()
      const sessions = {
        create: () => Effect.die("unexpected session"),
        get: () => Effect.die("unexpected session"),
        messages: () => Effect.die("unexpected session"),
        children: () => Effect.die("unexpected session"),
      }
      const runner = RayaTaskRunner.make({ storage, database, sessions, halt: () => Effect.void })
      const at = Date.now() + 60_000
      const worker = yield* runner.tasks.create({
        name: "Scheduled",
        objective: "Work",
        schedule: { kind: "once", at },
      })
      const queue = RayaTaskQueue.make(database)
      yield* queue.publish({ agentID: worker.id, version: 1, occurrences: [{ at, observedAt: at }] })
      const organizations = RayaTaskOrganization.make(database, { ...runner.tasks, stop: runner.stopMembers }, storage)
      const item = yield* organizations.create({ name: "Team", members: [{ agentID: worker.id, role: "Worker" }] })
      const ready = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const fiber = yield* claim(storage, worker.id, Effect.void, () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(ready, undefined)
          yield* Deferred.await(release)
        }),
      ).pipe(Effect.forkScoped)
      yield* Deferred.await(ready)
      expect(Exit.isFailure(yield* organizations.archive(item.id, { expectedRevision: 1 }).pipe(Effect.exit))).toBe(
        true,
      )
      expect((yield* organizations.list()).items.map((entry) => entry.id)).toContain(item.id)
      expect(yield* organizations.stopped(worker.id)).toBe(true)
      expect(yield* queue.pending(worker.id, 1)).toEqual([])
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(fiber)
      const restarted = RayaTaskRunner.make({ storage, database, sessions, halt: () => Effect.void })
      yield* restarted.recoverStops()
      expect((yield* organizations.get(item.id)).archived).toBe(true)
      expect((yield* restarted.tasks.get(worker.id)).enabled).toBe(false)
      expect(yield* restarted.tasks.runsFor(worker.id)).toEqual([])
      expect(Exit.isFailure(yield* restarted.fire(worker.id).pipe(Effect.exit))).toBe(true)
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("an orphaned startup claim keeps archive visible until explicit recovery", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const storage = memory()
      const sessions = {
        create: () => Effect.die("unexpected session"),
        get: () => Effect.die("unexpected session"),
        messages: () => Effect.die("unexpected session"),
        children: () => Effect.die("unexpected session"),
      }
      const runner = RayaTaskRunner.make({ storage, database, sessions, halt: () => Effect.void })
      const worker = yield* runner.tasks.create({ name: "Worker", objective: "Work", schedule: { kind: "manual" } })
      const organizations = RayaTaskOrganization.make(database, { ...runner.tasks, stop: runner.stopMembers }, storage)
      const item = yield* organizations.create({ name: "Team", members: [{ agentID: worker.id, role: "Worker" }] })
      const id = crypto.randomUUID()
      const key = ["raya", "agent-claims", createHash("sha256").update(worker.id).digest("hex")]
      yield* storage.create(key, {
        version: 1,
        agentID: worker.id,
        id,
        at: Date.now(),
        phase: "claimed",
        owner: { ...owner(), pid: 2_147_483_647 },
      })
      expect(Exit.isFailure(yield* organizations.archive(item.id, { expectedRevision: 1 }).pipe(Effect.exit))).toBe(
        true,
      )
      const restarted = RayaTaskRunner.make({ storage, database, sessions, halt: () => Effect.void })
      expect(Exit.isFailure(yield* restarted.recoverStops().pipe(Effect.exit))).toBe(true)
      expect((yield* organizations.list()).items.map((entry) => entry.id)).toContain(item.id)
      expect(yield* organizations.stopped(worker.id)).toBe(true)
      expect(Exit.isFailure(yield* restarted.fire(worker.id).pipe(Effect.exit))).toBe(true)
      yield* restarted.resolve(worker.id, id)
      yield* restarted.recoverStops()
      expect((yield* organizations.get(item.id)).archived).toBe(true)
      expect(yield* storage.list(["raya", "agent-claims"])).toEqual([])
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("failed session cancellation retains live delegation through archive retry", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const storage = memory()
      const sessions = {
        create: () => Effect.die("unexpected session"),
        get: () => Effect.die("unexpected session"),
        messages: () => Effect.succeed([]),
        children: () => Effect.succeed([]),
      }
      const tasks = RayaTask.make({ storage, database })
      const chief = yield* tasks.create({ name: "Chief", objective: "Lead", schedule: { kind: "manual" } })
      const dir = process.cwd()
      const worker = yield* tasks.create({ name: "Worker", objective: "Work", dir, schedule: { kind: "manual" } })
      const routed: string[] = []
      const workspace = {
        provide: <A, E, R>(input: InstanceStore.LoadInput, effect: Effect.Effect<A, E, R>) =>
          Effect.sync(() => {
            routed.push(input.directory)
          }).pipe(Effect.andThen(effect)),
      } as InstanceStore.Interface
      const failed = RayaTaskRunner.make({ storage, database, sessions, halt: () => Effect.die("halt failed") })
      const organizations = RayaTaskOrganization.make(database, { ...tasks, stop: failed.stopMembers }, storage)
      const item = yield* organizations.create({
        name: "Team",
        members: [
          { agentID: chief.id, role: "Chief" },
          { agentID: worker.id, role: "Worker" },
        ],
        delegations: [{ senderID: chief.id, recipientID: worker.id }],
      })
      const sid = SessionID.make("ses_archive_halt_failure")
      yield* database.db
        .insert(Delegation)
        .values({
          id: "rdl_archive_halt_failure",
          source: "archive_halt_failure",
          sender_id: chief.id,
          recipient_id: worker.id,
          organization_id: item.id,
          organization_name: item.name,
          organization_revision: item.revision,
          objective: "Review work",
          depth: 1,
          state: "running",
          session_id: sid,
          time_created: Date.now(),
          time_updated: Date.now(),
        })
        .run()
      expect(
        Exit.isFailure(
          yield* organizations
            .archive(item.id, { expectedRevision: 1 })
            .pipe(Effect.provideService(InstanceStore.Service, workspace), Effect.exit),
        ),
      ).toBe(true)
      expect(routed).toEqual([dir])
      expect((yield* database.db.select().from(Delegation).where(eq(Delegation.session_id, sid)).get())?.state).toBe(
        "running",
      )
      expect((yield* organizations.get(item.id)).archived).toBe(false)
      const resumed = RayaTaskRunner.make({ storage, database, sessions, halt: () => Effect.void })
      const retry = RayaTaskOrganization.make(database, { ...tasks, stop: resumed.stopMembers }, storage)
      expect(
        (yield* retry
          .archive(item.id, { expectedRevision: 1 })
          .pipe(Effect.provideService(InstanceStore.Service, workspace))).archived,
      ).toBe(true)
      expect(routed).toEqual([dir, dir])
      expect((yield* database.db.select().from(Delegation).where(eq(Delegation.session_id, sid)).get())?.state).toBe(
        "cancelled",
      )
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("organization stop does not launch another recipient's queued work", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const storage = memory()
      const sessions = {
        create: () => Effect.die("archive launched unrelated work"),
        get: () => Effect.die("unexpected session"),
        messages: () => Effect.succeed([]),
        children: () => Effect.succeed([]),
      }
      const runner = RayaTaskRunner.make({ storage, database, sessions, halt: () => Effect.void })
      const chief = yield* runner.tasks.create({ name: "Chief", objective: "Lead", schedule: { kind: "manual" } })
      const member = yield* runner.tasks.create({ name: "Member", objective: "Work", schedule: { kind: "manual" } })
      const outside = yield* runner.tasks.create({
        name: "Outside",
        objective: "Other work",
        schedule: { kind: "manual" },
      })
      const sender = yield* runner.tasks.create({
        name: "Independent",
        objective: "Assign",
        schedule: { kind: "manual" },
      })
      const organizations = RayaTaskOrganization.make(database, { ...runner.tasks, stop: runner.stopMembers }, storage)
      const item = yield* organizations.create({
        name: "Team",
        members: [
          { agentID: chief.id, role: "Chief" },
          { agentID: member.id, role: "Member" },
        ],
        delegations: [{ senderID: chief.id, recipientID: member.id }],
      })
      const now = Date.now()
      yield* database.db
        .insert(Delegation)
        .values([
          {
            id: "rdl_archive_root",
            source: "archive_root",
            sender_id: chief.id,
            recipient_id: member.id,
            organization_id: item.id,
            organization_name: item.name,
            organization_revision: item.revision,
            objective: "Review",
            depth: 1,
            state: "accepted",
            time_created: now,
            time_updated: now,
          },
          {
            id: "rdl_archive_child",
            source: "archive_child",
            sender_id: member.id,
            recipient_id: outside.id,
            parent_id: "rdl_archive_root",
            objective: "Help review",
            depth: 2,
            state: "queued",
            time_created: now + 1,
            time_updated: now + 1,
          },
          {
            id: "rdl_unrelated_queued",
            source: "unrelated_queued",
            sender_id: sender.id,
            recipient_id: outside.id,
            objective: "Unrelated work",
            depth: 1,
            state: "queued",
            time_created: now + 2,
            time_updated: now + 2,
          },
        ])
        .run()
      expect((yield* organizations.archive(item.id, { expectedRevision: 1 })).archived).toBe(true)
      expect(
        (yield* database.db.select().from(Delegation).where(eq(Delegation.id, "rdl_archive_child")).get())?.state,
      ).toBe("cancelled")
      expect(
        (yield* database.db.select().from(Delegation).where(eq(Delegation.id, "rdl_unrelated_queued")).get())?.state,
      ).toBe("queued")
      expect(yield* runner.tasks.runsFor(outside.id)).toEqual([])
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("routine usage names every durable evidence domain without mutating it", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const storage = memory()
      const tasks = RayaTask.make({ storage, database })
      const worker = yield* tasks.create({
        name: "Worker",
        objective: "Work",
        capabilities: ["organization:provision"],
        schedule: { kind: "manual" },
      })
      const peer = yield* tasks.create({ name: "Peer", objective: "Help", schedule: { kind: "manual" } })
      expect(yield* tasks.usage(worker.id)).toEqual({ used: [], unavailable: [] })

      yield* tasks.remember(worker.id, "Retained work memory")
      yield* storage.replace(
        ["raya", "agent-runs", worker.id],
        [
          {
            id: "run_usage",
            agentID: worker.id,
            at: 1,
            sessionID: SessionID.make("ses_usage"),
            status: "complete",
          },
        ],
      )
      yield* indexed(database).put({ id: worker.id, archived_at: 1, definition: JSON.stringify(worker) })
      yield* RayaTaskOrganization.make(database, tasks, storage).create({
        name: "Used worker",
        members: [{ agentID: worker.id, role: "Owner" }],
      })
      yield* RayaTaskQueue.make(database).publish({
        agentID: worker.id,
        version: 1,
        occurrences: [{ at: 1, observedAt: 2 }],
      })
      yield* RayaTaskDelegation.make(database).admit(
        { source: "usage", senderID: worker.id, recipientID: peer.id, objective: "Help" },
        worker,
        peer,
      )
      yield* RayaTaskInbox.make(database).publish({
        agentID: worker.id,
        source: "usage",
        kind: "system",
        body: "History",
      })
      yield* tasks.authority(worker.id, { enabled: false, expected: true }, "user")

      expect(yield* tasks.usage(worker.id)).toEqual({
        used: ["authority", "run", "memory", "archive", "organization", "queue", "delegation", "inbox"],
        unavailable: [],
      })
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("organization creation and worker removal share one deterministic mutation gate", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const storage = memory()
      const tasks = RayaTask.make({ storage, database })
      const worker = yield* tasks.create({ name: "Worker", objective: "Work", schedule: { kind: "manual" } })
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const organizations = RayaTaskOrganization.make(
        database,
        {
          get: (id) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
              return yield* tasks.get(id)
            }),
        },
        storage,
      )
      const creating = yield* organizations
        .create({ name: "Serialized", members: [{ agentID: worker.id, role: "Owner" }] })
        .pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      const removing = yield* tasks.remove(worker.id).pipe(Effect.exit, Effect.forkScoped)
      yield* Deferred.succeed(release, undefined)
      const organization = yield* Fiber.join(creating)
      const removed = yield* Fiber.join(removing)
      expect(organization.members[0]?.agentID).toBe(worker.id)
      expect(Exit.isFailure(removed)).toBe(true)
      expect(yield* organizations.hasActive(worker.id)).toBe(true)
      expect((yield* tasks.get(worker.id)).id).toBe(worker.id)
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})
