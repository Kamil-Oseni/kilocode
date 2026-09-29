import { expect } from "bun:test"
import { createHash } from "node:crypto"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { RayaRoutineDelegationTable as Delegation } from "@opencode-ai/core/kilocode/routine.sql"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Deferred, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Bus } from "@/bus"
import { GlobalBus } from "@/bus/global"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { RayaTaskExecution } from "@/kilocode/task/execution"
import { RayaTaskInbox } from "@/kilocode/task/inbox"
import { make as replyGate } from "@/kilocode/task/reply"
import { RayaTaskRunner } from "@/kilocode/task/runner"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { Storage } from "@/storage/storage"
import { testEffect } from "../lib/effect"

const root = LayerNode.group([
  Bus.node,
  Database.node,
  Session.node,
  SessionProjector.node,
  Storage.node,
  CrossSpawnSpawner.node,
  InstanceStore.node,
])
const env = AppNodeBuilder.build(root, [
  [
    InstanceStore.bootstrapNode,
    Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
  ],
])
const it = testEffect(env.pipe(Layer.provide(RuntimeFlags.layer())))

it.instance(
  "stale delegated reply events cannot reopen a later wait and permission receipts remain attributable",
  () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const database = yield* Database.Service
      const storage = yield* Storage.Service
      const sessions = yield* Session.Service
      const hold = yield* Deferred.make<void>()
      const entered = yield* Deferred.make<void>()
      const runner = RayaTaskRunner.make({
        database,
        storage,
        sessions,
        continuation: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(hold))),
      })
      const sender = yield* runner.tasks.create({
        name: "Coordinator",
        objective: "Coordinate one reviewed assignment",
        access: "brief",
        enabled: true,
        schedule: { kind: "manual" },
      })
      const recipient = yield* runner.tasks.create({
        name: "Reviewer",
        objective: "Review the delegated evidence",
        access: "brief",
        enabled: true,
        schedule: { kind: "manual" },
      })
      const row = yield* runner.delegate({
        source: `stale_${crypto.randomUUID()}`,
        senderID: sender.id,
        recipientID: recipient.id,
        objective: "Wait for the current reviewed answer",
        deadline: Date.now() + 60_000,
      })
      if (!row.sessionID || !row.childRunID) throw new Error("Expected an attached delegated run")
      const sid = row.sessionID
      const rid = row.childRunID
      const owner = { id: rid, agentID: recipient.id, sessionID: sid }
      yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"))

      const execution = RayaTaskExecution.make(storage)
      const receipt = yield* execution.receipt(owner)
      if (!receipt) throw new Error("Expected active delegated execution ownership")
      const release = Deferred.succeed(hold, undefined).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const idle = yield* execution.idle(owner, createHash("sha256").update(receipt.token).digest("hex"))
            if (!idle) yield* Effect.sleep("10 millis")
            return idle
          }).pipe(Effect.repeat({ until: (idle) => idle }), Effect.timeout("5 seconds")),
        ),
        Effect.andThen(execution.finish(owner).pipe(Effect.orDie)),
      )
      yield* Effect.gen(function* () {
        yield* RayaTaskRunner.subscribe({ bus, database, storage, sessions })
        GlobalBus.emit("event", {
          payload: {
            type: "permission.asked",
            properties: {
              id: "per_stale_delegated_reply",
              sessionID: sid,
              permission: "bash",
              patterns: ["echo reviewed"],
              tool: { messageID: "msg_stale_delegated_reply", callID: "call_stale_delegated_reply" },
            },
          },
        })

        expect(yield* replyGate({ database, storage }, true)(sid)).toBe(true)
        expect((yield* runner.tasks.runsFor(recipient.id)).find((run) => run.id === rid)).toMatchObject({
          status: "blocked",
          blockedReason: "waiting on you",
        })
        expect(yield* database.db.select().from(Delegation).where(eq(Delegation.id, row.id)).get()).toMatchObject({
          state: "needs_input",
        })

        GlobalBus.emit("event", {
          payload: {
            type: "question.replied",
            properties: {
              sessionID: sid,
              requestID: "que_previous_delegated_reply",
              answers: [["Previous answer"]],
            },
          },
        })
        GlobalBus.emit("event", {
          payload: {
            type: "permission.replied",
            properties: { sessionID: sid, requestID: "per_stale_delegated_reply", reply: "once" },
          },
        })

        const inbox = RayaTaskInbox.make(database)
        const page = yield* inbox.page(recipient.id).pipe(
          Effect.repeat({
            until: (value) =>
              value.messages.some(
                (message) => message.kind === "system" && message.body.includes("per_stale_delegated_reply"),
              ),
          }),
          Effect.timeout("5 seconds"),
        )
        expect(
          page.messages.filter(
            (message) => message.kind === "system" && message.body.includes("per_stale_delegated_reply"),
          ),
        ).toHaveLength(1)
        yield* Effect.sleep("100 millis")
        expect((yield* runner.tasks.runsFor(recipient.id)).find((run) => run.id === rid)).toMatchObject({
          status: "blocked",
          blockedReason: "waiting on you",
        })
        expect(yield* database.db.select().from(Delegation).where(eq(Delegation.id, row.id)).get()).toMatchObject({
          state: "needs_input",
        })
      }).pipe(Effect.ensuring(release.pipe(Effect.orDie)))
    }),
  { git: true },
  30_000,
)
