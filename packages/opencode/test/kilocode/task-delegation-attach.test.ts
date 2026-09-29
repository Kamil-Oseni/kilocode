import { expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { RayaRoutineDelegationTable as Delegation } from "@opencode-ai/core/kilocode/routine.sql"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Deferred, Effect, Exit, Layer } from "effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { RayaTask } from "@/kilocode/task"
import { RayaTaskDelegation } from "@/kilocode/task/delegation"
import { RayaTaskExecution } from "@/kilocode/task/execution"
import { RayaTaskInbox } from "@/kilocode/task/inbox"
import { RayaTaskRunner } from "@/kilocode/task/runner"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { Storage } from "@/storage/storage"
import { testEffect } from "../lib/effect"

const root = LayerNode.group([
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

const agent = (id: string): RayaTask.Agent => ({
  id,
  name: id,
  role: "generalist",
  objective: `${id} standing work`,
  capabilities: [],
  memoryScope: "project",
  schedule: { kind: "manual" },
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
  access: "full",
})

test("attach cannot resurrect a delegation terminalized during authorization", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const state = { id: "", armed: false }
      const store = RayaTaskDelegation.make(database, undefined, () =>
        Effect.gen(function* () {
          if (!state.armed) return false
          yield* database.db
            .update(Delegation)
            .set({ state: "cancelled", reason: "Stopped before attachment.", time_updated: Date.now() + 1 })
            .where(eq(Delegation.id, state.id))
            .run()
            .pipe(Effect.orDie)
          return false
        }),
      )
      const inbox = RayaTaskInbox.make(database)
      const sender = agent("attach_sender")
      const recipient = agent("attach_recipient")
      const admitted = yield* store.admit(
        {
          source: "attach_terminal_race",
          senderID: sender.id,
          recipientID: recipient.id,
          objective: "Do not start after the delegation is stopped.",
        },
        sender,
        recipient,
      )
      const taken = yield* store.take(recipient.id)
      if (!taken?.childRunID) throw new Error("Expected an accepted delegation")
      state.id = admitted.record.id
      state.armed = true

      const sid = SessionID.make("ses_attach_terminal_race")
      const result = yield* store.attach(taken.id, taken.childRunID, sid).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* store.get(taken.id)).toMatchObject({
        state: "cancelled",
        childRunID: taken.childRunID,
        reason: "Stopped before attachment.",
      })
      expect((yield* store.get(taken.id)).sessionID).toBeUndefined()
      expect((yield* inbox.page(sender.id)).messages.some((item) => item.source.startsWith("start:"))).toBe(false)
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

it.instance(
  "a stopped delegated run cannot enter its continuation after attachment",
  () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const storage = yield* Storage.Service
      const sessions = yield* Session.Service
      const stopped = yield* Deferred.make<void>()
      const state: { runner?: ReturnType<typeof RayaTaskRunner.make>; stopped: boolean } = { stopped: false }
      const wrapped = {
        create: sessions.create,
        messages: sessions.messages,
        children: sessions.children,
        get: (id: SessionID) =>
          sessions.get(id).pipe(
            Effect.tap(() =>
              Effect.gen(function* () {
                if (state.stopped || !state.runner) return
                const row = yield* database.db
                  .select()
                  .from(Delegation)
                  .where(eq(Delegation.session_id, id))
                  .get()
                  .pipe(Effect.orDie)
                if (!row?.child_run_id) return
                const run = (yield* state.runner.tasks.runsFor(row.recipient_id).pipe(Effect.orDie)).find(
                  (item) => item.id === row.child_run_id,
                )
                if (!run || run.status !== "running") return
                state.stopped = yield* state.runner.tasks
                  .transition(run, {
                    ...run,
                    status: "error",
                  })
                  .pipe(Effect.orDie)
                if (state.stopped) yield* Deferred.succeed(stopped, undefined)
              }),
            ),
          ),
      }
      const calls = { value: 0 }
      const runner = RayaTaskRunner.make({
        database,
        storage,
        sessions: wrapped,
        continuation: () =>
          Effect.sync(() => {
            calls.value += 1
          }),
      })
      state.runner = runner
      const sender = yield* runner.tasks.create({
        name: "Attach sender",
        objective: "Coordinate attached work",
        access: "brief",
        enabled: true,
        schedule: { kind: "manual" },
      })
      const recipient = yield* runner.tasks.create({
        name: "Attach recipient",
        objective: "Handle attached work",
        access: "brief",
        enabled: true,
        schedule: { kind: "manual" },
      })
      const row = yield* runner.delegate({
        source: `attach_stopped_${crypto.randomUUID()}`,
        senderID: sender.id,
        recipientID: recipient.id,
        objective: "Do not dispatch after this run stops.",
        deadline: Date.now() + 60_000,
      })
      if (!row.childRunID) throw new Error("Expected an attached delegated run")
      yield* Deferred.await(stopped).pipe(Effect.timeout("15 seconds"))
      if (!row.sessionID) throw new Error("Expected an attached delegated session")
      const execution = RayaTaskExecution.make(storage)
      const owner = { id: row.childRunID, agentID: recipient.id, sessionID: row.sessionID }
      expect((yield* execution.receipt(owner))?.state).toBe("active")
      const idle = yield* Effect.gen(function* () {
        for (const _ of Array.from({ length: 500 })) {
          const receipt = yield* execution.receipt(owner)
          if (receipt?.state === "idle") return true
          yield* Effect.sleep("10 millis")
        }
        return false
      })
      expect(idle).toBe(true)
      yield* execution.finish(owner)

      expect(state.stopped).toBe(true)
      expect((yield* runner.tasks.runsFor(recipient.id)).find((item) => item.id === row.childRunID)?.status).toBe(
        "error",
      )
      expect(calls.value).toBe(0)
      expect(yield* execution.receipt(owner)).toBeUndefined()
    }),
  { git: true },
  30000,
)
