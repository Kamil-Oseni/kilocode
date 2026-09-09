import { expect } from "bun:test"
import { Effect, Exit, Schema } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node]), [
    [Database.node, Database.layerFromPath(":memory:")],
  ]),
)
const event = EventV2.define({
  type: "test.raya.prepared",
  durable: { version: 1, aggregate: "id" },
  schema: { id: Schema.String, text: Schema.String },
})

it.effect("validates before projection and admits only one competing conditional publication", () =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service
    yield* db.run("CREATE TABLE prepare_probe (value TEXT NOT NULL)")
    yield* db.run("INSERT INTO prepare_probe VALUES ('original')")
    const order: string[] = []
    yield* events.project(event, () =>
      Effect.gen(function* () {
        order.push("project")
        yield* db.run("UPDATE prepare_probe SET value = 'saved'").pipe(Effect.orDie)
      }),
    )
    yield* events.listen(() =>
      Effect.sync(() => {
        order.push("notify")
      }),
    )
    const publish = events.publish(
      event,
      { id: "aggregate", text: "saved" },
      {
        prepare: (seq) =>
          Effect.gen(function* () {
            const row = yield* db.get<{ value: string }>("SELECT value FROM prepare_probe").pipe(Effect.orDie)
            if (row?.value !== "original") return yield* Effect.die("stale review")
            order.push(`prepare:${seq}`)
          }),
        commit: () =>
          Effect.sync(() => {
            order.push("commit")
          }),
      },
    )
    const results = yield* Effect.all([publish.pipe(Effect.exit), publish.pipe(Effect.exit)], {
      concurrency: "unbounded",
    })
    expect(results.filter(Exit.isSuccess)).toHaveLength(1)
    expect(results.filter(Exit.isFailure)).toHaveLength(1)
    expect(order).toEqual(["prepare:0", "project", "commit", "notify"])
    const saved = yield* db.select().from(EventTable).all()
    expect(saved).toHaveLength(1)
    expect(saved[0].data).toEqual({ id: "aggregate", text: "saved" })
    expect(yield* db.get("SELECT value FROM prepare_probe")).toEqual({ value: "saved" })
  }),
)

it.effect("rolls back failed preparation without projecting, notifying or consuming a sequence", () =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service
    yield* db.run("CREATE TABLE prepare_rollback (value TEXT NOT NULL)")
    const calls: string[] = []
    yield* events.project(event, () =>
      Effect.sync(() => {
        calls.push("project")
      }),
    )
    yield* events.listen(() =>
      Effect.sync(() => {
        calls.push("notify")
      }),
    )
    const result = yield* events
      .publish(
        event,
        { id: "rejected", text: "no" },
        {
          prepare: () =>
            Effect.gen(function* () {
              yield* db.run("INSERT INTO prepare_rollback VALUES ('temporary')").pipe(Effect.orDie)
              return yield* Effect.die("invalid precondition")
            }),
        },
      )
      .pipe(Effect.exit)
    expect(Exit.isFailure(result)).toBe(true)
    expect(calls).toEqual([])
    expect(yield* db.all("SELECT * FROM prepare_rollback")).toEqual([])
    expect(yield* db.select().from(EventTable).all()).toEqual([])
    expect(yield* db.select().from(EventSequenceTable).all()).toEqual([])
    const local = EventV2.define({ type: "test.raya.local", schema: { text: Schema.String } })
    const rejected = yield* events.publish(local, { text: "no" }, { prepare: () => Effect.void }).pipe(Effect.exit)
    expect(Exit.isFailure(rejected)).toBe(true)
  }),
)
