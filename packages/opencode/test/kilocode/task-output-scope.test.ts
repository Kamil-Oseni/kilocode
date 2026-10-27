import { expect, test } from "bun:test"
import path from "node:path"
import { Effect, Exit, Schema } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { RayaRoutineDelegationTable as Delegation } from "@opencode-ai/core/kilocode/routine.sql"
import { RayaTaskDelegation } from "@/kilocode/task/delegation"
import { RayaTask } from "@/kilocode/task"
import * as Files from "@/kilocode/task/output-scope"
import { tmpdir } from "../fixture/fixture"

const agent = (id: string): RayaTask.Agent => ({
  id,
  name: id,
  role: "generalist",
  objective: "Bounded work",
  capabilities: [],
  memoryScope: "project",
  schedule: { kind: "manual" },
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
  access: "full",
})

test("exact output schema preserves readonly and rejects ambiguous Windows aliases", () => {
  expect(Schema.decodeUnknownSync(Files.Outputs)([])).toEqual([])
  const root = path.resolve("outputs")
  expect(Schema.is(Files.Outputs)([path.join(root, "a.txt")])).toBe(true)
  for (const leaf of ["a*.txt", "a\u0001.txt", "a\u007f.txt"])
    expect(Schema.is(Files.Outputs)([path.join(root, leaf)])).toBe(false)
  if (process.platform !== "win32") return
  for (const leaf of ["a.txt.", "a.txt ", "a.txt::$DATA", "con.txt", "COM¹.log", "a:meta", "a|b"])
    expect(Schema.is(Files.Outputs)([path.join(root, leaf)])).toBe(false)
  expect(Schema.is(Files.Outputs)(["\\rootrelative.txt"])).toBe(false)
  expect(Schema.is(Files.Outputs)([path.join(root, "a.txt"), path.join(root, "A.txt")])).toBe(false)
})

test("physical output reservations survive reopen, include terminal siblings and serialize overlap", async () => {
  await using dir = await tmpdir()
  const file = path.join(dir.path, "scope.sqlite")
  const own = path.join(dir.path, "research.md")
  const other = path.join(dir.path, "index.html")
  const chief = agent("chief")
  const researcher = agent("researcher")
  const builder = agent("builder")
  const sales = agent("sales")
  const root = await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Database.Service
      const fs = yield* FSUtil.Service
      const store = RayaTaskDelegation.make(db)
      expect(
        (yield* db.db.all<{ file: string }>("PRAGMA database_list")).some(
          (row) => row.file.toLowerCase() === file.toLowerCase(),
        ),
      ).toBe(true)
      expect(yield* Files.canonical(fs, [own])).toEqual([own])
      yield* Effect.promise(() => Bun.file(own).write("research"))
      expect(yield* Files.canonical(fs, [own])).toEqual([own])
      const first = yield* store.admit(
        { source: "scope-root", senderID: chief.id, recipientID: researcher.id, objective: "Research", outputs: [own] },
        chief,
        researcher,
      )
      const readonly = yield* store.admit(
        { source: "scope-readonly", senderID: chief.id, recipientID: sales.id, objective: "Read only", outputs: [] },
        chief,
        sales,
      )
      expect(readonly.record.outputs).toEqual([])
      expect(
        Exit.isFailure(
          yield* store
            .admit(
              {
                source: "scope-missing",
                senderID: researcher.id,
                recipientID: builder.id,
                parentID: first.record.id,
                objective: "Build",
              },
              researcher,
              builder,
            )
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(
        Exit.isFailure(
          yield* store
            .admit(
              {
                source: "scope-parent-overlap",
                senderID: researcher.id,
                recipientID: builder.id,
                parentID: first.record.id,
                objective: "Build",
                outputs: [own],
              },
              researcher,
              builder,
            )
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      const children = yield* Effect.all(
        [builder, sales].map((recipient) =>
          store
            .admit(
              {
                source: `scope-child-${recipient.id}`,
                senderID: researcher.id,
                recipientID: recipient.id,
                parentID: first.record.id,
                objective: "Write own stage",
                outputs: [other],
              },
              researcher,
              recipient,
            )
            .pipe(Effect.exit),
        ),
        { concurrency: "unbounded" },
      )
      expect(children.filter(Exit.isSuccess)).toHaveLength(1)
      const saved = children.find(Exit.isSuccess)!
      expect(saved.value.record.outputs).toEqual([other])
      yield* db.db
        .update(Delegation)
        .set({ state: "completed", response: "Done" })
        .where(eq(Delegation.id, saved.value.record.id))
        .run()
      expect(
        Exit.isFailure(
          yield* store
            .admit(
              {
                source: "scope-terminal-overlap",
                senderID: researcher.id,
                recipientID: builder.id,
                parentID: first.record.id,
                objective: "Overwrite",
                outputs: [other],
              },
              researcher,
              builder,
            )
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      const legacy = yield* store.admit(
        { source: "scope-legacy", senderID: chief.id, recipientID: builder.id, objective: "Legacy" },
        chief,
        builder,
      )
      expect(legacy.record.outputs).toBeUndefined()
      return { id: first.record.id, readonly: readonly.record.id, legacy: legacy.record.id }
    }).pipe(Effect.provide(FSUtil.defaultLayer), Effect.provide(Database.layerFromPath(file)), Effect.scoped),
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Database.Service
      const store = RayaTaskDelegation.make(db)
      expect((yield* store.get(root.id)).outputs).toEqual([own])
      expect((yield* store.get(root.readonly)).outputs).toEqual([])
      expect((yield* store.get(root.legacy)).outputs).toBeUndefined()
      yield* db.db.update(Delegation).set({ outputs: "invalid-json" }).where(eq(Delegation.id, root.id)).run()
      expect(Exit.isFailure(yield* store.get(root.id).pipe(Effect.exit))).toBe(true)
    }).pipe(Effect.provide(Database.layerFromPath(file)), Effect.scoped),
  )
})
