import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { RayaRoutineDelegationTable } from "@opencode-ai/core/kilocode/routine.sql"
import { expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { Session } from "@/session/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Storage } from "@/storage/storage"
import { Question } from "@/question"
import { Permission } from "@/permission"
import { RayaTaskRunner } from "@/kilocode/task/runner"
import { RayaTaskExecution } from "@/kilocode/task/execution"
import { make } from "@/kilocode/task/reply"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { QuestionID } from "@/question/schema"
import { testEffect } from "../lib/effect"

const root = LayerNode.group([
  Database.node,
  EventV2Bridge.node,
  Session.node,
  SessionProjector.node,
  Storage.node,
  Question.node,
  Permission.node,
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
const questions = [
  {
    header: "Continue",
    question: "Continue the assigned review?",
    options: [{ label: "Yes", description: "Continue" }],
  },
]

const setup = Effect.gen(function* () {
  const database = yield* Database.Service
  const storage = yield* Storage.Service
  const sessions = yield* Session.Service
  const hold = yield* Deferred.make<void>()
  const entered = yield* Deferred.make<void>()
  // Only the model invocation is held; session creation, assignment, snapshot,
  // execution ownership and reply authority use their production implementations.
  const runner = RayaTaskRunner.make({
    database,
    storage,
    sessions,
    continuation: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(hold))),
  })
  const sender = yield* runner.tasks.create({
    name: "Coordinator",
    objective: "Coordinate review",
    access: "brief",
    enabled: true,
    schedule: { kind: "manual" },
  })
  const recipient = yield* runner.tasks.create({
    name: "Reviewer",
    objective: "Review evidence",
    access: "brief",
    enabled: true,
    schedule: { kind: "manual" },
  })
  const row = yield* runner.delegate({
    source: `reply_${crypto.randomUUID()}`,
    senderID: sender.id,
    recipientID: recipient.id,
    objective: "Review the retained evidence",
    deadline: Date.now() + 60_000,
  })
  if (!row.sessionID || !row.childRunID) throw new Error("Expected admitted original assignment")
  yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"))
  yield* runner.park(row.sessionID, true)
  const execution = RayaTaskExecution.make(storage)
  const owner = { id: row.childRunID, agentID: recipient.id, sessionID: row.sessionID }
  const release = Effect.gen(function* () {
    yield* Deferred.succeed(hold, undefined)
    for (const _ of Array.from({ length: 500 })) {
      const receipt = yield* execution.receipt(owner)
      if (!receipt || receipt.state === "idle") {
        yield* execution.finish(owner)
        return
      }
      yield* Effect.sleep("10 millis")
    }
    throw new Error("Owned fixture body did not reach durable idle")
  }).pipe(Effect.orDie)
  return {
    database,
    storage,
    sessions,
    runner,
    recipient,
    row: { ...row, sessionID: row.sessionID, childRunID: row.childRunID },
    release,
  }
})

const pending = <T>(read: () => Effect.Effect<readonly T[]>) =>
  Effect.gen(function* () {
    for (const _ of Array.from({ length: 200 })) {
      const rows = yield* read()
      if (rows.length) return rows[0]
      yield* Effect.sleep("10 millis")
    }
    throw new Error("Expected pending request")
  })

it.instance(
  "direct Question reply restores exact assignment before releasing its waiter",
  () =>
    Effect.gen(function* () {
      const state = yield* setup
      yield* Effect.gen(function* () {
        const question = yield* Question.Service
        const fiber = yield* question.ask({ sessionID: state.row.sessionID, questions }).pipe(Effect.forkScoped)
        const request = yield* pending(question.list)
        yield* question.reply({ requestID: request.id, answers: [["Yes"]] })
        expect(yield* Fiber.join(fiber)).toEqual([["Yes"]])
        const row = yield* state.database.db
          .select()
          .from(RayaRoutineDelegationTable)
          .where(eq(RayaRoutineDelegationTable.id, state.row.id))
          .get()
        expect(row?.state).toBe("running")
        expect(
          (yield* state.runner.tasks.runsFor(state.recipient.id)).find((run) => run.id === state.row.childRunID)
            ?.status,
        ).toBe("running")
      }).pipe(Effect.ensuring(state.release))
    }),
  { git: true },
  30000,
)

for (const mode of ["expired", "permissions changed", "orphan"] as const)
  it.instance(
    `direct Question approval stays pending when assignment is ${mode}`,
    () =>
      Effect.gen(function* () {
        const state = yield* setup
        yield* Effect.gen(function* () {
          const question = yield* Question.Service
          const fiber = yield* question.ask({ sessionID: state.row.sessionID, questions }).pipe(Effect.forkScoped)
          const request = yield* pending(question.list)
          if (mode === "expired")
            yield* state.database.db
              .update(RayaRoutineDelegationTable)
              .set({ deadline: Date.now() - 1 })
              .where(eq(RayaRoutineDelegationTable.id, state.row.id))
              .run()
          if (mode === "permissions changed")
            yield* state.sessions.setPermission({
              sessionID: state.row.sessionID,
              permission: [{ permission: "*", pattern: "*", action: "allow" }],
            })
          if (mode === "orphan")
            yield* state.storage.replace(
              ["raya", "agent"],
              (yield* state.runner.tasks.list()).filter((item) => item.id !== state.recipient.id),
            )
          expect(
            Exit.isFailure(yield* question.reply({ requestID: request.id, answers: [["Yes"]] }).pipe(Effect.exit)),
          ).toBe(true)
          expect((yield* question.list()).map((item) => item.id)).toContain(request.id)
          expect(fiber.pollUnsafe()).toBeUndefined()
          yield* question.reject(request.id)
        }).pipe(Effect.ensuring(state.release))
      }),
    { git: true },
    30000,
  )

for (const mode of [
  "once",
  "always",
  "allowEverything",
  "saved rules",
  "sibling always",
  "sibling saved rules",
] as const)
  it.instance(
    `Permission ${mode} cannot release an expired delegated waiter`,
    () =>
      Effect.gen(function* () {
        const state = yield* setup
        yield* Effect.gen(function* () {
          const permission = yield* Permission.Service
          const fiber = yield* permission
            .ask({
              sessionID: state.row.sessionID,
              permission: "bash",
              patterns: ["echo fixture"],
              always: ["echo *"],
              metadata: {},
              ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
            })
            .pipe(Effect.forkScoped)
          const request = yield* pending(permission.list)
          yield* state.database.db
            .update(RayaRoutineDelegationTable)
            .set({ deadline: Date.now() - 1 })
            .where(eq(RayaRoutineDelegationTable.id, state.row.id))
            .run()
          if (mode === "once" || mode === "always")
            expect(
              Exit.isFailure(yield* permission.reply({ requestID: request.id, reply: mode }).pipe(Effect.exit)),
            ).toBe(true)
          if (mode === "allowEverything")
            yield* permission.allowEverything({ enable: true, requestID: request.id, sessionID: state.row.sessionID })
          if (mode === "saved rules")
            yield* permission.saveAlwaysRules({ requestID: request.id, approvedAlways: ["echo *"] })
          if (mode === "sibling always" || mode === "sibling saved rules") {
            const session = yield* state.sessions.create({ title: "Independent approval" })
            const sibling = yield* permission
              .ask({
                sessionID: session.id,
                permission: "bash",
                patterns: ["echo independent"],
                always: ["echo *"],
                metadata: {},
                ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
              })
              .pipe(Effect.forkScoped)
            const trigger = yield* pending(() =>
              permission.list().pipe(Effect.map((rows) => rows.filter((row) => row.sessionID === session.id))),
            )
            if (mode === "sibling always") yield* permission.reply({ requestID: trigger.id, reply: "always" })
            if (mode === "sibling saved rules") {
              yield* permission.saveAlwaysRules({ requestID: trigger.id, approvedAlways: ["echo *"] })
              yield* permission.reply({ requestID: trigger.id, reply: "once" })
            }
            yield* Fiber.join(sibling)
          }
          expect((yield* permission.list()).map((item) => item.id)).toContain(request.id)
          expect(fiber.pollUnsafe()).toBeUndefined()
          yield* permission.reply({ requestID: request.id, reply: "reject" })
        }).pipe(Effect.ensuring(state.release))
      }),
    { git: true },
    30000,
  )

it.instance(
  "ordinary session reply authority preserves normal answer behavior",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Ordinary conversation" })
      const gate = make({ database: yield* Database.Service, storage: yield* Storage.Service })
      expect(yield* gate(session.id)).toBe(true)
    }),
  { git: true },
  30000,
)

for (const kind of ["Question", "Permission"] as const)
  it.instance(
    `valid ${kind} rejection restores original WAIT run without approving the tool`,
    () =>
      Effect.gen(function* () {
        const state = yield* setup
        yield* Effect.gen(function* () {
          if (kind === "Question") {
            const service = yield* Question.Service
            const fiber = yield* service.ask({ sessionID: state.row.sessionID, questions }).pipe(Effect.forkScoped)
            const request = yield* pending(service.list)
            yield* service.reject(request.id)
            expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)
          }
          if (kind === "Permission") {
            const service = yield* Permission.Service
            const fiber = yield* service
              .ask({
                sessionID: state.row.sessionID,
                permission: "bash",
                patterns: ["echo reject"],
                always: [],
                metadata: {},
                ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
              })
              .pipe(Effect.forkScoped)
            const request = yield* pending(service.list)
            yield* service.reply({ requestID: request.id, reply: "reject" })
            expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)
          }
          expect(
            (yield* state.runner.tasks.runsFor(state.recipient.id)).find((run) => run.id === state.row.childRunID)
              ?.status,
          ).toBe("running")
          expect(
            (yield* state.database.db
              .select()
              .from(RayaRoutineDelegationTable)
              .where(eq(RayaRoutineDelegationTable.id, state.row.id))
              .get())?.state,
          ).toBe("running")
        }).pipe(Effect.ensuring(state.release))
      }),
    { git: true },
    30000,
  )

for (const kind of ["Question", "Permission"] as const)
  it.instance(
    `${kind} Replied observes settled acceptance; later revocation refuses without a second Replied`,
    () =>
      Effect.gen(function* () {
        const state = yield* setup
        yield* Effect.gen(function* () {
          const events = yield* EventV2Bridge.Service
          const question = yield* Question.Service
          const permission = yield* Permission.Service
          const ask = (): Effect.Effect<void, Question.RejectedError | Permission.Error> =>
            kind === "Question"
              ? question.ask({ sessionID: state.row.sessionID, questions }).pipe(Effect.asVoid)
              : permission
                  .ask({
                    sessionID: state.row.sessionID,
                    permission: "bash",
                    patterns: ["echo observe"],
                    always: [],
                    metadata: {},
                    ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
                  })
                  .pipe(Effect.asVoid)
          const fiber = yield* ask().pipe(Effect.forkScoped)
          const requests = (): Effect.Effect<readonly { id: string }[]> =>
            kind === "Question" ? question.list() : permission.list()
          const request = yield* pending(requests)
          const seen: string[] = []
          const off = yield* events.listen((event) => {
            if (
              event.type !== (kind === "Question" ? Question.Event.Replied.type : Permission.Event.Replied.type) ||
              !event.data ||
              typeof event.data !== "object" ||
              !("requestID" in event.data)
            )
              return Effect.void
            if ("reply" in event.data && event.data.reply === "reject") return Effect.void
            const id = String(event.data.requestID)
            return Effect.gen(function* () {
              seen.push(id)
              expect(id).toBe(request.id)
              expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(true)
              expect((yield* requests()).some((item) => item.id === request.id)).toBe(false)
              yield* state.sessions.setPermission({
                sessionID: state.row.sessionID,
                permission: [{ permission: "*", pattern: "*", action: "allow" }],
              })
            })
          })
          yield* Effect.addFinalizer(() => off)
          if (kind === "Question") yield* question.reply({ requestID: QuestionID.make(request.id), answers: [["Yes"]] })
          if (kind === "Permission")
            yield* permission.reply({ requestID: PermissionV1.ID.make(request.id), reply: "once" })
          expect(seen).toEqual([request.id])
          const next = yield* ask().pipe(Effect.forkScoped)
          const refused = yield* pending(requests)
          const outcome =
            kind === "Question"
              ? yield* question.reply({ requestID: QuestionID.make(refused.id), answers: [["Yes"]] }).pipe(Effect.exit)
              : yield* permission
                  .reply({ requestID: PermissionV1.ID.make(refused.id), reply: "once" })
                  .pipe(Effect.exit)
          expect(outcome._tag).toBe("Failure")
          expect(seen).toEqual([request.id])
          expect((yield* requests()).some((item) => item.id === refused.id)).toBe(true)
          expect(next.pollUnsafe()).toBeUndefined()
          if (kind === "Question") yield* question.reject(QuestionID.make(refused.id))
          if (kind === "Permission")
            yield* permission.reply({ requestID: PermissionV1.ID.make(refused.id), reply: "reject" })
          expect(Exit.isFailure(yield* Fiber.await(next))).toBe(true)
        }).pipe(Effect.ensuring(state.release))
      }),
    { git: true },
    30000,
  )
