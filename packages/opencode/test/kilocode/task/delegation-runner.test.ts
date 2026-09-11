import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
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
