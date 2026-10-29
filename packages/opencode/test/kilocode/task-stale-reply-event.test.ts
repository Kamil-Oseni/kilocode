import { expect } from "bun:test"
import { createHash } from "node:crypto"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { RayaRoutineDelegationTable as Delegation } from "@opencode-ai/core/kilocode/routine.sql"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Deferred, Effect, Layer, Schedule } from "effect"
import { eq } from "drizzle-orm"
import { Bus } from "@/bus"
import { GlobalBus } from "@/bus/global"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { RayaTaskExecution } from "@/kilocode/task/execution"
import { RayaTaskInbox } from "@/kilocode/task/inbox"
import { make as replyGate } from "@/kilocode/task/reply"
import { RayaTaskRunner } from "@/kilocode/task/runner"
import { RayaTask } from "@/kilocode/task"
import { RayaGoal } from "@/kilocode/goal"
import { RayaTaskDelegation } from "@/kilocode/task/delegation"
import { RayaTaskSnapshot } from "@/kilocode/task/snapshot"
import { RayaRoutineReports } from "@/kilocode/task/projection"
import { failure } from "@/kilocode/task/final-error"
import { KiloSessionEvent } from "@/kilocode/session/event"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { testEffect } from "../lib/effect"
import { database as physical, storage as files } from "./fixtures/effect-profile"

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
  [Database.node, physical],
  [Storage.node, files],
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
            schedule: Schedule.spaced(10),
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

it.instance(
  "an original retired producer failure settles its premature complete Routine without accepting child success",
  () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const database = yield* Database.Service
      const storage = yield* Storage.Service
      const sessions = yield* Session.Service
      const execution = RayaTaskExecution.make(storage)
      const gates = new Map<string, Deferred.Deferred<void>>()
      const starts: string[] = []
      yield* RayaTaskRunner.subscribe({ bus, database, storage, sessions })
      const runner = RayaTaskRunner.make({
        database,
        storage,
        sessions,
        continuation: (run) =>
          Effect.gen(function* () {
            const gate = yield* Deferred.make<void>()
            gates.set(run.id, gate)
            starts.push(run.id)
            yield* Deferred.await(gate)
          }),
      })
      const errands = RayaTaskDelegation.make(database)
      const snapshots = RayaTaskSnapshot.make({ storage })
      const goals = RayaGoal.make({ database, storage, sessions })
      const chat = yield* sessions.create({ title: "Original producer failure report" })
      const reports = RayaRoutineReports.make({
        storage,
        sessions,
        scope: { projectID: chat.projectID, directory: chat.directory },
      })
      const sender = yield* runner.tasks.create({
        name: "Coordinator",
        objective: "Coordinate one bounded failure observation",
        access: "brief",
        enabled: true,
        schedule: { kind: "manual" },
      })
      const parent = yield* runner.tasks.create({
        name: "Researcher",
        model: { providerID: "test", id: "test" },
        objective: "Observe the original request without claiming child work",
        access: "brief",
        enabled: true,
        schedule: { kind: "manual" },
      })
      const child = yield* runner.tasks.create({
        name: "Reviewer",
        model: { providerID: "test", id: "test" },
        objective: "Reply with an acknowledgement only; no file work is requested",
        access: "brief",
        enabled: true,
        schedule: { kind: "manual" },
      })
      const original = yield* runner.delegate(
        {
          source: `producer_error_${crypto.randomUUID()}`,
          senderID: sender.id,
          recipientID: parent.id,
          objective: "Wait for the original review reply before delivering the requested result",
          criteria: [
            { id: "reply", description: "Deliver the requested parent result", verification: "Original reply" },
          ],
        },
        { reportSessionID: chat.id },
      )
      if (!original.sessionID || !original.childRunID) throw new Error("Original delegated run was not attached")
      const queued = yield* runner.delegate({
        source: `producer_error_next_${crypto.randomUUID()}`,
        senderID: sender.id,
        recipientID: parent.id,
        objective: "A separate later request must not start from the failed producer's idle event",
      })
      expect(queued.state).toBe("queued")
      const assigned = yield* runner.delegate({
        source: `producer_error_child_${crypto.randomUUID()}`,
        senderID: parent.id,
        recipientID: child.id,
        parentID: original.id,
        objective: "Acknowledge this message; no files, tools or external work are requested",
      })
      if (!assigned.sessionID || !assigned.childRunID) throw new Error("Original child was not attached")
      const first = (yield* runner.tasks.runsFor(parent.id)).find((run) => run.id === original.childRunID)
      const second = (yield* runner.tasks.runsFor(child.id)).find((run) => run.id === assigned.childRunID)
      if (!first || !second) throw new Error("Actual saved Run identities disappeared")
      const idle = (run: RayaTask.Run) =>
        Effect.gen(function* () {
          const receipt = yield* execution.receipt(run)
          if (!receipt) return true
          return yield* execution.idle(run, createHash("sha256").update(receipt.token).digest("hex"))
        }).pipe(Effect.repeat({ schedule: Schedule.spaced(10), until: (value) => value }), Effect.timeout("5 seconds"))
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* Effect.forEach([...gates.values()], (gate) => Deferred.succeed(gate, undefined), { discard: true })
          yield* Effect.forEach([first, second], (run) => idle(run).pipe(Effect.andThen(execution.finish(run))), {
            discard: true,
          })
        }).pipe(Effect.orDie),
      )
      yield* Effect.sync(() => gates.size).pipe(
        Effect.repeat({ schedule: Schedule.spaced(10), until: (value) => value === 2 }),
        Effect.timeout("5 seconds"),
      )
      const transcript = (run: RayaTask.Run, fault: boolean) =>
        Effect.gen(function* () {
          const session = yield* sessions.get(run.sessionID)
          const goal = yield* goals.get(run.sessionID)
          if (!goal?.intent || !session.agent) throw new Error("Original Goal or agent identity missing")
          const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") }
          const user = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: run.sessionID,
            agent: session.agent,
            model,
            time: { created: Date.now() },
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            type: "text",
            sessionID: run.sessionID,
            messageID: user.id,
            text: fault ? "Deliver the requested parent result" : "Acknowledge only; no work claim",
          })
          const bound = yield* goals.initial(run.sessionID, goal.intent, session.agent)
          if (!bound?.dispatch) throw new Error("Actual original dispatch was not bound")
          const assistant = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            role: "assistant",
            sessionID: run.sessionID,
            parentID: user.id,
            agent: session.agent,
            mode: session.agent,
            ...model,
            path: { cwd: session.directory, root: session.directory },
            time: { created: Date.now(), completed: Date.now() },
            finish: "stop",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            ...(fault
              ? { error: { name: "UnknownError" as const, data: { message: "Original producer failed" } } }
              : {}),
          })
          if (!fault)
            yield* sessions.updatePart({
              id: PartID.ascending(),
              type: "text",
              sessionID: run.sessionID,
              messageID: assistant.id,
              text: "Acknowledged. No file or external work was requested or performed.",
            })
          if (fault) {
            // Reproduce the retained legacy state: a premature accepted Goal is
            // distinct from an actual successful final assistant or Run outcome.
            yield* storage.replace(["raya", "goal", run.sessionID], {
              ...bound,
              status: "complete",
              activeAt: undefined,
            })
          }
          if (!fault) yield* goals.recordTurn(run.sessionID, assistant.id, goal.intent)
          const finished = yield* goals.finished(run.sessionID, assistant.id, fault ? "error" : "completed")
          if (!finished) throw new Error("Actual terminal assistant was not acknowledged")
          return { session, user, assistant, goal: finished }
        })
      yield* transcript(second, false)
      const gate = gates.get(second.id)
      if (!gate) throw new Error("Actual child producer gate missing")
      yield* Deferred.succeed(gate, undefined)
      yield* idle(second)
      yield* runner.settle(second.sessionID)
      expect((yield* errands.get(assigned.id)).state).toBe("completed")
      const kept = (yield* runner.tasks.runsFor(child.id)).find((run) => run.id === second.id)
      expect(kept?.status).toBe("complete")
      expect(kept?.outcome?.summary).toBe("Acknowledged. No file or external work was requested or performed.")
      const failed = yield* transcript(first, true)
      const snapshot = yield* snapshots.find(first.id)
      if (!snapshot) throw new Error("Immutable original snapshot missing")
      const rows = yield* sessions.messages({ sessionID: first.sessionID })
      expect(failure(first, failed.goal, failed.session, snapshot, rows)).toBeDefined()
      expect(failure({ ...first, id: "foreign-run" }, failed.goal, failed.session, snapshot, rows)).toBeUndefined()
      expect(failure(first, { ...failed.goal, intent: "replaced" }, failed.session, snapshot, rows)).toBeUndefined()
      expect(failure(first, failed.goal, failed.session, snapshot, rows.slice(0, -1))).toBeUndefined()
      yield* bus.publish(KiloSessionEvent.TurnClose, {
        sessionID: first.sessionID,
        messageID: failed.assistant.id,
        goalIntent: failed.goal.intent,
        reason: "error",
      })
      yield* runner.settle(first.sessionID)
      expect((yield* errands.get(original.id)).state).toBe("running")
      expect((yield* runner.tasks.runsFor(parent.id)).find((run) => run.id === first.id)?.status).toBe("running")
      const release = gates.get(first.id)
      if (!release) throw new Error("Actual original producer gate missing")
      yield* Deferred.succeed(release, undefined)
      yield* idle(first)
      const settled = yield* errands
        .get(original.id)
        .pipe(
          Effect.repeat({ schedule: Schedule.spaced(10), until: (value) => value.state === "failed" }),
          Effect.timeout("5 seconds"),
        )
      expect(settled.state).toBe("failed")
      expect((yield* errands.get(queued.id)).state).toBe("queued")
      expect((yield* errands.get(queued.id)).childRunID).toBeUndefined()
      const done = (yield* runner.tasks.runsFor(parent.id)).find((run) => run.id === first.id)
      expect(done?.status).toBe("error")
      expect(done?.outcome?.report).toBeUndefined()
      expect(done?.outcome?.summary).not.toBe(kept?.outcome?.summary)
      expect((yield* errands.get(assigned.id)).state).toBe("completed")
      expect((yield* runner.tasks.runsFor(child.id)).find((run) => run.id === second.id)).toEqual(kept)
      const cards = (yield* reports.list(chat.id)).filter((card) => card.id === original.id)
      expect(cards).toHaveLength(1)
      expect(cards[0]?.status).toBe("error")
      const replies = (yield* RayaTaskInbox.make(database).page(sender.id)).messages.filter(
        (message) => message.source === `reply:${original.source}`,
      )
      expect(replies).toHaveLength(1)
      expect(replies[0]?.body).toContain("failed")
      yield* runner.settle(first.sessionID)
      yield* bus.publish(KiloSessionEvent.TurnClose, {
        sessionID: first.sessionID,
        messageID: failed.assistant.id,
        goalIntent: failed.goal.intent,
        reason: "error",
      })
      yield* runner.settle(first.sessionID)
      expect((yield* reports.list(chat.id)).filter((card) => card.id === original.id)).toEqual(cards)
      expect(
        (yield* RayaTaskInbox.make(database).page(sender.id)).messages.filter(
          (message) => message.source === `reply:${original.source}`,
        ),
      ).toEqual(replies)
      expect(starts).toEqual([first.id, second.id])
      expect((yield* errands.get(queued.id)).state).toBe("queued")
      expect((yield* runner.tasks.runsFor(parent.id)).map((run) => run.id)).toEqual([first.id])
      expect((yield* execution.receipt(first))?.state).not.toBe("active")
      expect((yield* goals.get(first.sessionID))?.status).toBe("complete")
    }),
  { git: true },
  30_000,
)
