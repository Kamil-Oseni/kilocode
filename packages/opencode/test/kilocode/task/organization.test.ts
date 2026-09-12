import { expect, test } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { RayaRoutineOrganizationRevisionTable as Revision } from "@opencode-ai/core/kilocode/routine.sql"
import { RayaTask } from "@/kilocode/task"
import { RayaTaskInbox } from "@/kilocode/task/inbox"
import { RayaTaskOrganization } from "@/kilocode/task/organization"
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
        members: [
          { agentID: chief.id, role: "CEO" },
          { agentID: books.id, role: "Accounting", supervisorID: chief.id },
          { agentID: design.id, role: "Chief Designer", supervisorID: chief.id },
        ],
      })
      expect(created.id).toMatch(/^org_[a-f0-9]{32}$/)
      expect(created.revision).toBe(1)
      expect(created.members.map((member) => member.position)).toEqual([0, 1, 2])
      expect(yield* organizations.hasActive(books.id)).toBe(true)
      expect(yield* organizations.contains(created.id, [chief.id, books.id])).toBe(true)
      expect(yield* organizations.contains(created.id, [chief.id, "missing"])).toBe(false)
      expect(Exit.isFailure(yield* tasks.remove(books.id).pipe(Effect.exit))).toBe(true)

      const updated = yield* organizations.update(created.id, {
        expectedRevision: 1,
        purpose: null,
        members: [
          { agentID: chief.id, role: "CEO" },
          { agentID: design.id, role: "Design", supervisorID: chief.id },
          { agentID: books.id, role: "Finance", supervisorID: chief.id },
        ],
      })
      expect(updated.revision).toBe(2)
      expect(updated.purpose).toBeUndefined()
      expect(updated.members.map((member) => member.agentID)).toEqual([chief.id, design.id, books.id])
      expect(
        Exit.isFailure(
          yield* organizations.update(created.id, { expectedRevision: 1, name: "Stale" }).pipe(Effect.exit),
        ),
      ).toBe(true)
      const revisions = yield* database.db.select().from(Revision).where(eq(Revision.organization_id, created.id)).all()
      expect(revisions.map((row) => row.revision)).toEqual([1, 2])
      expect(JSON.parse(revisions[0]!.definition).members[1].role).toBe("Accounting")

      const archived = yield* organizations.archive(created.id, { expectedRevision: 2 })
      expect(archived).toMatchObject({ archived: true, revision: 3 })
      expect((yield* organizations.list()).items).toEqual([])
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
      expect((yield* organizations.list()).items).toEqual([])
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
