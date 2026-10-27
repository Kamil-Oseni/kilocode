import { expect } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Database } from "@opencode-ai/core/database/database"
import { Git } from "@/git"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Storage } from "@/storage/storage"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID } from "@/session/schema"
import { SessionRunState } from "@/session/run-state"
import { ToolRegistry } from "@/tool/registry"
import { RayaGoal } from "@/kilocode/goal"
import { binding, compaction } from "@/kilocode/goal/turn"
import * as GoalGate from "@/kilocode/goal/tool-gate"
import * as TaskWorker from "@/kilocode/session/task-worker"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { database, storage as stored } from "./fixtures/effect-profile"
import { InputReceipt } from "@opencode-ai/core/kilocode/input-receipt"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      ToolRegistry.node,
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      TaskWorker.node,
      Storage.node,
      CrossSpawnSpawner.node,
      FSUtil.node,
      Git.node,
    ]),
  ),
)

const scoped = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      Storage.node,
      FSUtil.node,
      Git.node,
      CrossSpawnSpawner.node,
    ]),
    [
      [Database.node, database],
      [Storage.node, stored],
    ],
  ),
)

for (const mode of ["continue", "replay"])
  scoped.live(
    `verified compaction ${mode} binds resumed evidence and tools without accepting forged or successor input`,
    () =>
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const storage = yield* Storage.Service
          const runs = yield* SessionRunState.Service
          const bind = yield* binding
          const goals = RayaGoal.make({ storage, sessions })
          const identity = {
            version: 1,
            agentID: "researcher",
            runID: "run-compaction",
            scheduleVersion: 1,
            trigger: { kind: "manual" },
          }
          const session = yield* sessions.create({ metadata: { rayaRoutine: identity } })
          yield* Effect.addFinalizer(() => goals.clear(session.id))
          const user = () =>
            sessions.updateMessage({
              id: MessageID.ascending(),
              sessionID: session.id,
              role: "user",
              time: { created: Date.now() },
              agent: "code",
              model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
            })
          const assistant = (parent: MessageV2.User, summary = false) =>
            sessions.updateMessage({
              id: MessageID.ascending(),
              parentID: parent.id,
              sessionID: session.id,
              role: "assistant",
              agent: summary ? "compaction" : "code",
              mode: "code",
              summary,
              finish: summary ? "stop" : undefined,
              time: { created: Date.now(), completed: summary ? Date.now() : undefined },
              path: { cwd: session.directory, root: session.directory },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              providerID: ProviderV2.ID.make("test"),
              modelID: ModelV2.ID.make("test-model"),
            })
          const original = yield* user()
          const raw = yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: original.id,
            sessionID: session.id,
            type: "text",
            text: "Write research and hand it off",
            synthetic: mode === "replay" ? true : undefined,
          })
          const source = mode === "replay" ? InputReceipt.seal(original, [raw])! : raw
          if (mode === "replay") yield* sessions.updatePart(source)
          const first = yield* assistant(original)
          yield* goals.create(
            session.id,
            "Write research and hand it off",
            original.id,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            { agentID: identity.agentID, runID: identity.runID, sessionID: session.id },
          )
          return yield* runs.ensureRunning(
            session.id,
            Effect.succeed({ info: first, parts: [] }),
            Effect.gen(function* () {
              yield* bind(sessions, runs, session.id)
              const before = yield* goals.get(session.id)
              expect(before?.inputs).toEqual([original.id])
              const marker = yield* user()
              const token = yield* sessions.updatePart({
                id: PartID.ascending(),
                messageID: marker.id,
                sessionID: session.id,
                type: "compaction",
                auto: false,
              })
              const summary = yield* assistant(marker, true)
              yield* sessions.updatePart({
                id: PartID.ascending(),
                messageID: summary.id,
                sessionID: session.id,
                type: "text",
                text: "Research still needs a verified handoff.",
              })
              const current = yield* user()
              const notice = yield* sessions.updatePart(
                mode === "replay"
                  ? {
                      ...source,
                      id: PartID.ascending(),
                      messageID: current.id,
                    }
                  : {
                      id: PartID.ascending(),
                      messageID: current.id,
                      sessionID: session.id,
                      type: "text",
                      synthetic: true,
                      metadata: { compaction_continue: true },
                      text: "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
                    },
              )
              const message = yield* assistant(current)
              yield* bind(sessions, runs, session.id)
              expect((yield* goals.get(session.id))?.dispatch?.messageID).toBe(original.id)
              yield* sessions.updatePart({ ...token, auto: true })
              yield* sessions.updatePart({ ...notice, synthetic: false })
              yield* bind(sessions, runs, session.id)
              expect((yield* goals.get(session.id))?.dispatch?.messageID).toBe(original.id)
              yield* sessions.updatePart(notice)
              yield* sessions.updateMessage({ ...summary, finish: "error" })
              yield* bind(sessions, runs, session.id)
              expect((yield* goals.get(session.id))?.dispatch?.messageID).toBe(original.id)
              yield* sessions.updateMessage(summary)
              if (mode === "replay") {
                yield* sessions.updatePart({ ...notice, text: "A different request behind a copied input seal" })
                yield* bind(sessions, runs, session.id)
                expect((yield* goals.get(session.id))?.dispatch?.messageID).toBe(original.id)
                yield* sessions.updatePart(notice)
                for (const value of [
                  { ...before, intent: "stale-replay-intent" },
                  { ...before, completion: "reply" },
                  { ...before, status: "paused", pause: "user-control" },
                  { ...before, status: "blocked" },
                ]) {
                  yield* storage.replace(["raya", "goal", session.id], value)
                  yield* bind(sessions, runs, session.id)
                  expect((yield* goals.get(session.id))?.dispatch?.messageID).toBe(original.id)
                }
                yield* storage.replace(["raya", "goal", session.id], {
                  ...before,
                  inputs: [...before!.inputs!, current.id],
                })
              }
              yield* bind(sessions, runs, session.id)
              const saved = yield* goals.get(session.id)
              expect(saved?.dispatch?.messageID).toBe(current.id)
              expect(saved?.dispatch?.id).not.toBe(before?.dispatch?.id)
              expect(saved?.inputs).toEqual([original.id, current.id])
              expect(saved?.intent).toBe(before?.intent)
              expect(saved?.createdAt).toBe(before?.createdAt)
              const schema = GoalGate.owned({}, goals.get)
              const check = yield* GoalGate.prepare(schema, session.id, current.id, () => Effect.succeed(current.id))
              const tools = GoalGate.bind({}, check, Effect.runPromise)
              expect(yield* GoalGate.required(tools)).toBe(true)
              expect(yield* GoalGate.closed(tools)).toBe(false)
              const successor = yield* user()
              yield* sessions.updatePart({
                id: PartID.ascending(),
                messageID: successor.id,
                sessionID: session.id,
                type: "text",
                text: "New unrelated request",
              })
              yield* assistant(successor)
              yield* bind(sessions, runs, session.id)
              expect((yield* goals.get(session.id))?.inputs).toEqual([original.id, current.id])
              const next = yield* GoalGate.prepare(schema, session.id, successor.id, () => Effect.succeed(successor.id))
              expect(yield* GoalGate.required(GoalGate.bind({}, next, Effect.runPromise))).toBe(false)
              return { info: message, parts: [] }
            }),
          )
        }),
      ),
    30_000,
  )

scoped.live(
  "compaction restores only the current routine's active work goal despite a different dispatch parent",
  () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const storage = yield* Storage.Service
        const goals = RayaGoal.make({ storage, sessions })
        const resume = yield* compaction
        const identity = {
          version: 1,
          agentID: "researcher",
          runID: "run-original",
          scheduleVersion: 1,
          trigger: { kind: "manual" },
        }
        const session = yield* sessions.create({ metadata: { rayaRoutine: identity } })
        yield* Effect.addFinalizer(() => goals.clear(session.id))
        const routine = { agentID: identity.agentID, runID: identity.runID, sessionID: session.id }
        yield* goals.create(
          session.id,
          "Write research and hand off verified files",
          undefined,
          undefined,
          undefined,
          undefined,
          { modelCost: 100 },
          undefined,
          routine,
        )
        const queued = yield* goals.continued(session.id)
        if (!queued?.dispatch) throw new Error("Expected an original goal dispatch")
        const current = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "code",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
        })
        const part = yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: current.id,
          sessionID: session.id,
          type: "text",
          text: "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
          synthetic: true,
          metadata: { compaction_continue: true },
        })
        expect(current.id).not.toBe(queued.dispatch.messageID)
        const before = yield* goals.get(session.id)
        expect(yield* resume(yield* sessions.get(session.id), [part])).toContain("call it before further work")
        expect(yield* goals.get(session.id)).toEqual(before)
        expect(yield* resume(session, [{ ...part, synthetic: false }])).toBeUndefined()
        expect(yield* resume(session, [{ ...part, metadata: {} }])).toBeUndefined()
        yield* sessions.setMetadata({
          sessionID: session.id,
          metadata: { rayaRoutine: { ...identity, runID: "run-other" } },
        })
        expect(yield* resume(yield* sessions.get(session.id), [part])).toBeUndefined()
        yield* sessions.setMetadata({ sessionID: session.id, metadata: { rayaRoutine: identity } })
        yield* goals.control(session.id, "paused")
        expect(yield* resume(yield* sessions.get(session.id), [part])).toBeUndefined()
        yield* goals.clear(session.id)
        expect(yield* resume(yield* sessions.get(session.id), [part])).toBeUndefined()
        yield* goals.create(
          session.id,
          "Answer a question",
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          "reply",
          routine,
        )
        expect(yield* resume(yield* sessions.get(session.id), [part])).toBeUndefined()
      }),
    ),
  30_000,
)

it.live(
  "client-armed and tool-created goals stop current and historical inputs while preserving unrelated input",
  () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const storage = yield* Storage.Service
          const runs = yield* SessionRunState.Service
          const workers = yield* TaskWorker.Service
          const registry = yield* ToolRegistry.Service
          const bind = yield* binding
          const goals = RayaGoal.make({ storage, sessions })
          const tool = (yield* registry.all()).find((item) => item.id === "create_goal")
          if (!tool) throw new Error("Missing goal tool")
          for (const [source, mode] of ["client", "tool"].flatMap((source) =>
            ["latest", "historical", "unrelated"].map((mode) => [source, mode]),
          )) {
            const session = yield* sessions.create({})
            yield* Effect.addFinalizer(() => goals.clear(session.id))
            const user = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              sessionID: session.id,
              role: "user",
              time: { created: Date.now() },
              agent: "code",
              model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
            } satisfies MessageV2.User)
            const assistant = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              parentID: user.id,
              sessionID: session.id,
              role: "assistant",
              time: { created: Date.now() },
              agent: "code",
              mode: "code",
              path: { cwd: session.directory, root: session.directory },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              providerID: user.model.providerID,
              modelID: user.model.modelID,
            } satisfies MessageV2.Assistant)
            if (source === "client") yield* goals.create(session.id, "Own the first turn", user.id)
            const created = yield* Deferred.make<void>()
            const next = MessageID.ascending()
            const operation =
              source === "client"
                ? bind(sessions, runs, session.id).pipe(Effect.asVoid)
                : tool
                    .execute(
                      { objective: "Own the first turn" },
                      {
                        sessionID: session.id,
                        messageID: assistant.id,
                        agent: "code",
                        abort: AbortSignal.any([]),
                        messages: [],
                        metadata: () => Effect.void,
                        ask: () => Effect.die("Unexpected approval"),
                      },
                    )
                    .pipe(Effect.asVoid)
            const work = yield* runs
              .ensureRunning(
                session.id,
                Effect.succeed({ info: assistant, parts: [] }),
                Effect.gen(function* () {
                  expect(yield* workers.bind(session.id, user.id)).toBe(true)
                  yield* operation
                  if (mode !== "latest") {
                    yield* sessions.updateMessage({ ...user, id: next, time: { created: Date.now() } })
                    if (mode === "unrelated") expect(yield* workers.bind(session.id, next)).toBe(true)
                  }
                  yield* Deferred.succeed(created, undefined)
                  return yield* Effect.never
                }).pipe(Effect.ensuring(workers.release)),
              )
              .pipe(Effect.forkChild)
            yield* Deferred.await(created)
            const goal = yield* goals.get(session.id)
            expect(goal?.dispatch?.phase).toBe("started")
            expect(goal?.dispatch?.messageID).toBe(user.id)
            expect(goal?.inputs).toEqual([user.id])
            expect(goal?.dispatch?.worker).toBe((yield* runs.inspect(session.id)).id)
            expect(goal?.usage.continuations).toBe(0)
            expect(goal?.startMessageID).toBe(source === "client" ? user.id : assistant.id)
            const current = mode === "latest" ? goal! : yield* goals.revise(session.id, "Revised direction")
            if (mode !== "latest") {
              const queued = yield* goals.continued(session.id, current.intent)
              expect(queued?.dispatch?.phase).toBe("queued")
              expect(queued?.inputs).toEqual([user.id])
            }
            expect((yield* goals.stop(session.id, current.intent!, runs, undefined, workers)).interrupted).toBe(
              mode !== "unrelated",
            )
            if (mode === "unrelated") {
              expect((yield* runs.inspect(session.id)).id).toBe(goal?.dispatch?.worker)
              expect(yield* workers.cancel(session.id, next)).toBe(true)
            }
            yield* Fiber.join(work)
            expect((yield* runs.inspect(session.id)).phase).toBe("idle")
          }
        }),
      {
        git: true,
        config: {
          enabled_providers: [],
          default_agent: "code",
          formatter: false,
          lsp: false,
          indexing: { enabled: false },
        },
      },
    ),
  60_000,
)

it.live(
  "registered goal plan tool accepts a first-plan goal revision, is idempotent, and rejects stale writes",
  () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const storage = yield* Storage.Service
          const registry = yield* ToolRegistry.Service
          const goals = RayaGoal.make({ storage, sessions })
          const session = yield* sessions.create({})
          yield* Effect.addFinalizer(() => goals.clear(session.id))
          const goal = yield* goals.create(session.id, "Verify the complete deliverable")
          const tool = (yield* registry.all()).find((item) => item.id === "update_goal_plan")
          if (!tool) throw new Error("Missing goal plan tool")
          const read = (yield* registry.all()).find((item) => item.id === "get_goal")
          if (!read) throw new Error("Missing goal read tool")
          const input = {
            expectedIntent: goal.intent!,
            expectedRevision: null,
            tasks: [
              {
                id: "verify",
                description: "Verify output",
                output: "Check results",
                owner: "code",
                verification: "Run tests",
                status: "pending",
                dependencies: [],
              },
            ],
          }
          const ctx = {
            sessionID: session.id,
            messageID: MessageID.ascending(),
            agent: "code",
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.die("Unexpected approval"),
          }
          const before = JSON.parse((yield* read.execute({}, ctx)).output)
          expect(before.planUpdate).toEqual({ expectedIntent: goal.intent, expectedRevision: null })
          const saved = yield* tool.execute({ ...input, expectedRevision: goal.revision }, ctx)
          expect(saved.title).toBe("Goal plan saved")
          const revision = (yield* goals.get(session.id))?.plan?.revision
          expect((yield* goals.get(session.id))?.plan?.tasks[0].id).toBe("verify")
          const repeated = yield* tool.execute({ ...input, expectedRevision: goal.revision }, ctx)
          expect(repeated.title).toBe("Goal plan saved")
          expect((yield* goals.get(session.id))?.plan?.revision).toBe(revision)
          const after = JSON.parse((yield* read.execute({}, ctx)).output)
          expect(after.planUpdate).toEqual({ expectedIntent: goal.intent, expectedRevision: revision })
          const repeatedNull = yield* tool.execute(input, ctx)
          expect(repeatedNull.title).toBe("Goal plan saved")
          expect((yield* goals.get(session.id))?.plan?.revision).toBe(revision)
          const rejected = yield* tool.execute({ ...input, tasks: [{ ...input.tasks[0], status: "in_progress" }] }, ctx)
          expect(rejected.title).toBe("Goal plan not saved")
          expect(rejected.output).toContain("changed")
          expect(rejected.output).toContain(`"expectedRevision":"${revision}"`)
          const changed = yield* tool.execute(
            { ...input, expectedRevision: goal.revision, tasks: [{ ...input.tasks[0], status: "in_progress" }] },
            ctx,
          )
          expect(changed.title).toBe("Goal plan not saved")
          const updated = yield* tool.execute(
            { ...input, expectedRevision: revision!, tasks: [{ ...input.tasks[0], status: "in_progress" }] },
            ctx,
          )
          expect(updated.title).toBe("Goal plan saved")
          expect((yield* goals.get(session.id))?.status).toBe("active")
        }),
      {
        git: true,
        config: {
          enabled_providers: [],
          default_agent: "code",
          formatter: false,
          lsp: false,
          indexing: { enabled: false },
        },
      },
    ),
  60_000,
)
