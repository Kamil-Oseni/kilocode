import { afterEach, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { MessageID, PartID } from "@/session/schema"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { admit } from "@/kilocode/tool/task-admission"
import { Refusal } from "@/kilocode/session/tool-refusal"
import { SessionRetirement } from "@/kilocode/session/retirement"
import { ChiefTaskBinding } from "@/kilocode/chief/task-binding"
import { RayaChief } from "@/kilocode/chief"
import * as TaskLocal from "@/kilocode/tool/task-local"
import { ProviderTest } from "../fake/provider"
import { disposeAllInstances, tmpdirScoped, provideInstance, testInstanceStoreLayer } from "../fixture/fixture"
import path from "node:path"
import { testEffect } from "../lib/effect"

afterEach(disposeAllInstances)
const ref = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }
// Only the model catalog and prompt boundary are controlled; actual Task, Session and BackgroundJob execute.
const model = ProviderTest.model({ providerID: ref.providerID, id: ref.modelID })
const provider = ProviderTest.fake({ model })
const graph = LayerNode.group([
  Agent.node,
  BackgroundJob.node,
  EventV2Bridge.node,
  Config.node,
  CrossSpawnSpawner.node,
  Session.node,
  SessionProjector.node,
  SessionRunState.node,
  SessionStatus.node,
  Truncate.node,
  ToolRegistry.node,
  Provider.node,
  Question.node,
  Permission.node,
  Database.node,
  RuntimeFlags.node,
  Ripgrep.node,
])
const it = testEffect(
  Layer.mergeAll(
    testInstanceStoreLayer,
    LayerNode.compile(graph, [
      [Provider.node, provider.layer],
      [RuntimeFlags.node, RuntimeFlags.layer()],
    ]),
  ),
)

it.live(
  "root Auto no-cloud request refuses the actual Task before producing a child",
  () =>
    Effect.gen(function* () {
      for (const [local, restricted] of [
        [false, true],
        [true, true],
        [false, false],
      ] as const) {
        const dir = yield* tmpdirScoped()
        const selected = ProviderTest.fake({
          model,
          info: ProviderTest.info({ options: { localInference: local } }, model),
        })
        yield* provideInstance(dir)(
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const request = restricted
              ? "Read the supplied report. Use saved local models, no cloud, no standing changes, no budget/deadline keys."
              : "Read the supplied report."
            const root = yield* sessions.create({
              metadata: { [RayaChief.requestKey]: request, [RayaChief.phaseKey]: "task" },
            })
            const user = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              sessionID: root.id,
              role: "user",
              agent: "auto",
              model: ref,
              time: { created: Date.now() },
            })
            yield* sessions.updatePart({
              id: PartID.ascending(),
              sessionID: root.id,
              messageID: user.id,
              type: "text",
              text: request,
            })
            const assistant = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              sessionID: root.id,
              parentID: user.id,
              role: "assistant",
              agent: "auto",
              mode: "auto",
              providerID: ref.providerID,
              modelID: ref.modelID,
              cost: 0,
              path: { cwd: dir, root: dir },
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: Date.now() },
            })
            const part = yield* sessions.updatePart({
              id: PartID.ascending(),
              sessionID: root.id,
              messageID: assistant.id,
              type: "tool",
              tool: "task",
              callID: "local-selection",
              state: { status: "running", input: {}, time: { start: Date.now() } },
            })
            const calls = { count: 0 }
            const ops: TaskPromptOps = {
              cancel: () => Effect.void,
              resolvePromptParts: (text) => Effect.succeed([{ type: "text", text }]),
              prompt: (input) =>
                Effect.gen(function* () {
                  calls.count += 1
                  if (!input.messageID || !input.agent) throw new Error("Child invocation missing")
                  yield* sessions.updateMessage({
                    id: input.messageID,
                    sessionID: input.sessionID,
                    role: "user",
                    agent: input.agent,
                    model: ref,
                    time: { created: Date.now() },
                  })
                  const info = yield* sessions.updateMessage({
                    ...assistant,
                    id: MessageID.ascending(),
                    sessionID: input.sessionID,
                    parentID: input.messageID,
                    agent: input.agent,
                    mode: input.agent,
                    finish: "stop",
                    time: { created: Date.now(), completed: Date.now() },
                  })
                  const text = yield* sessions.updatePart({
                    id: PartID.ascending(),
                    sessionID: input.sessionID,
                    messageID: info.id,
                    type: "text",
                    text: "Observed fixture only",
                  })
                  return { info, parts: [text] }
                }),
            }
            const tool = yield* TaskTool.pipe(Effect.flatMap((info) => info.init()))
            const ctx = {
              sessionID: root.id,
              messageID: assistant.id,
              agent: "auto",
              callID: "local-selection",
              abort: new AbortController().signal,
              extra: { promptOps: ops },
              messages: [],
              ask: () => Effect.void,
              metadata: (value: { metadata?: Record<string, unknown> }) =>
                sessions
                  .updatePart({
                    ...part,
                    state: { status: "running", input: {}, time: { start: Date.now() }, metadata: value.metadata },
                  })
                  .pipe(Effect.asVoid),
            }
            const result = yield* Effect.exit(
              tool.execute({ subagent_type: "general", access: "read", prompt: "Read the supplied report" }, ctx),
            )
            if (restricted && !local) {
              expect(Exit.isFailure(result)).toBe(true)
              if (Exit.isFailure(result)) expect(String(Cause.squash(result.cause))).toContain("forbids cloud workers")
              expect(calls.count).toBe(0)
              expect(yield* sessions.children(root.id)).toEqual([])
              expect(yield* (yield* BackgroundJob.Service).list()).toEqual([])
              for (const text of [
                "Explain the phrase 'No cloud workers.'",
                "Do not require no cloud workers.",
                "```\nNo cloud workers.\n```\nRead the report.",
              ]) {
                const userpart = (yield* sessions.messages({ sessionID: root.id })).find(
                  (row) => row.info.id === user.id,
                )?.parts[0]
                if (!userpart || userpart.type !== "text") throw new Error("Original user text missing")
                yield* sessions.updatePart({ ...userpart, text })
                yield* sessions.setMetadata({
                  sessionID: root.id,
                  metadata: { [RayaChief.requestKey]: text, [RayaChief.phaseKey]: "task" },
                })
                expect(
                  Exit.isSuccess(
                    yield* Effect.exit(
                      TaskLocal.check({
                        sessions,
                        provider: yield* Provider.Service,
                        sessionID: root.id,
                        messageID: assistant.id,
                        agent: "auto",
                        providerID: ref.providerID,
                      }),
                    ),
                  ),
                ).toBe(true)
              }
            }
            if (local || !restricted) {
              expect(Exit.isSuccess(result)).toBe(true)
              if (Exit.isFailure(result)) throw Cause.squash(result.cause)
              expect(calls.count).toBe(1)
              expect((yield* sessions.children(root.id)).length).toBe(1)
            }
          }).pipe(
            Effect.provide(
              Layer.fresh(
                LayerNode.compile(graph, [
                  [Database.node, Database.layerFromPath(path.join(dir, "local-task.sqlite"))],
                  [Provider.node, selected.layer],
                  [RuntimeFlags.node, RuntimeFlags.layer()],
                ]),
              ),
            ),
          ),
        )
      }
    }),
  20_000,
)

it.live("fresh duplicate Auto Task is refused before child creation regardless of execution order", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    yield* provideInstance(dir)(
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "Fresh duplicate Task" })
        const user = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: root.id,
          role: "user",
          agent: "auto",
          model: ref,
          time: { created: Date.now() },
        })
        const assistant = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: root.id,
          parentID: user.id,
          role: "assistant",
          agent: "auto",
          mode: "auto",
          providerID: ref.providerID,
          modelID: ref.modelID,
          cost: 0,
          path: { cwd: dir, root: dir },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: Date.now() },
        })
        const params = { description: "Read a report file", prompt: "Read the report", access: "read" as const }
        const current = yield* sessions.updateMessage({ ...assistant, id: MessageID.ascending() })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: root.id,
          messageID: assistant.id,
          type: "tool",
          tool: "task",
          callID: "duplicate",
          state: { status: "running", input: params, time: { start: Date.now() } },
        })
        for (const [callID, input] of [
          ["original", params],
          ["duplicate", params],
          ["distinct", { ...params, prompt: "Read a different report" }],
          ["branch", { ...params, branch_id: "distinct-plan" }],
          ["resume", { ...params, task_id: root.id }],
        ] as const)
          yield* sessions.updatePart({
            id: PartID.ascending(),
            sessionID: root.id,
            messageID: current.id,
            type: "tool",
            tool: "task",
            callID,
            state: { status: "running", input, time: { start: Date.now() } },
          })
        const before = yield* sessions.messages({ sessionID: root.id })
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const result = yield* def
          .execute(params, {
            sessionID: root.id,
            messageID: current.id,
            callID: "duplicate",
            agent: "auto",
            abort: new AbortController().signal,
            extra: {},
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          })
          .pipe(Effect.exit)
        if (Exit.isSuccess(result)) throw new Error("Duplicate Task unexpectedly created a child")
        const error = Cause.squash(result.cause)
        expect(error).toBeInstanceOf(Refusal)
        if (!(error instanceof Refusal)) throw error
        expect(error.reason).toBe("task-concurrent")
        expect(yield* sessions.children(root.id)).toEqual([])
        expect(yield* sessions.messages({ sessionID: root.id })).toEqual(before)
        for (const [callID, input] of [
          ["original", params],
          ["distinct", { ...params, prompt: "Read a different report" }],
          ["resume", { ...params, task_id: root.id }],
        ] as const)
          expect(
            (yield* ChiefTaskBinding.load({
              sessions,
              sessionID: root.id,
              messageID: current.id,
              agent: "auto",
              callID,
              params: input,
            })).branch,
          ).toBeUndefined()
        const branch = yield* ChiefTaskBinding.load({
          sessions,
          sessionID: root.id,
          agent: "auto",
          callID: "branch",
          messageID: current.id,
          params: { ...params, branch_id: "distinct-plan" },
        }).pipe(Effect.exit)
        expect(Exit.isFailure(branch)).toBe(true)
        if (Exit.isFailure(branch))
          expect(String(Cause.squash(branch.cause))).toContain("No saved Auto Chief plan matches")
      }),
    )
  }),
)

it.live("actual same-child Task rejects an overlapping wait without changing the admitted child", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    yield* provideInstance(dir)(
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "Concurrent Task" })
        const user = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: root.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        })
        const assistant = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          sessionID: root.id,
          parentID: user.id,
          agent: "build",
          mode: "build",
          providerID: ref.providerID,
          modelID: ref.modelID,
          cost: 0,
          path: { cwd: "/tmp", root: "/tmp" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: Date.now() },
        })
        const child = yield* sessions.create({ parentID: root.id, title: "Original child" })
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const calls = { count: 0 }
        const ops: TaskPromptOps = {
          cancel: () => Effect.void,
          resolvePromptParts: (text) => Effect.succeed([{ type: "text", text }]),
          prompt: (input) =>
            Effect.gen(function* () {
              calls.count += 1
              if (!input.messageID || !input.agent) throw new Error("Actual Task input identity absent")
              const message = input.messageID
              const agent = input.agent
              yield* sessions.updateMessage({
                id: message,
                sessionID: input.sessionID,
                role: "user",
                agent: agent,
                model: ref,
                time: { created: Date.now() },
              })
              yield* sessions.updatePart({
                id: PartID.ascending(),
                messageID: message,
                sessionID: input.sessionID,
                type: "text",
                text: "Actual admitted input",
              })
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
              const info = yield* sessions.updateMessage({
                id: MessageID.ascending(),
                role: "assistant",
                sessionID: input.sessionID,
                parentID: message,
                agent: agent,
                mode: agent,
                providerID: ref.providerID,
                modelID: ref.modelID,
                cost: 0,
                path: { cwd: "/tmp", root: "/tmp" },
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                time: { created: Date.now(), completed: Date.now() },
                finish: "stop",
              })
              const part = yield* sessions.updatePart({
                id: PartID.ascending(),
                messageID: info.id,
                sessionID: info.sessionID,
                type: "text",
                text: "Original completed work",
              })
              return { info, parts: [part] }
            }),
        }
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const ctx = {
          sessionID: root.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: ops },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        }
        const original = yield* def
          .execute({ task_id: child.id, prompt: "Continue original work", subagent_type: "general" }, ctx)
          .pipe(Effect.forkChild)
        yield* Effect.addFinalizer(() =>
          Deferred.succeed(release, undefined).pipe(Effect.andThen(Fiber.await(original)), Effect.asVoid),
        )
        yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"))
        const before = yield* sessions.get(child.id)
        const rows = yield* sessions.messages({ sessionID: child.id })
        const collision = yield* def.execute({ task_id: child.id, description: "wait" }, ctx).pipe(Effect.exit)
        if (Exit.isSuccess(collision)) throw new Error("Concurrent Task unexpectedly entered")
        const error = Cause.squash(collision.cause)
        expect(error).toBeInstanceOf(Refusal)
        if (!(error instanceof Refusal)) throw error
        expect(error.reason).toBe("task-concurrent")
        expect(calls.count).toBe(1)
        expect(yield* sessions.get(child.id)).toEqual(before)
        expect(yield* sessions.messages({ sessionID: child.id })).toEqual(rows)
        yield* Deferred.succeed(release, undefined)
        expect((yield* Fiber.join(original)).metadata.sessionId).toBe(child.id)
        expect(
          (yield* def.execute({ task_id: child.id, prompt: "Sequential continuation", subagent_type: "general" }, ctx))
            .metadata.sessionId,
        ).toBe(child.id)
        expect(calls.count).toBe(2)
        expect((yield* sessions.children(root.id)).map((item) => item.id)).toEqual([child.id])
      }).pipe(
        Effect.provide(
          Layer.fresh(
            LayerNode.compile(graph, [
              [Database.node, Database.layerFromPath(path.join(dir, "task.sqlite"))],
              [Provider.node, provider.layer],
              [RuntimeFlags.node, RuntimeFlags.layer()],
            ]),
          ),
        ),
      ),
    )
  }),
)

test("admission holds through scoped finalizers and releases after interruption and failure", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const id = `finalizer-${crypto.randomUUID()}`
        const original = yield* admit(
          id,
          Effect.scoped(
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() =>
                Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
              )
            }),
          ),
        ).pipe(Effect.forkChild)
        yield* Effect.addFinalizer(() =>
          Deferred.succeed(release, undefined).pipe(Effect.andThen(Fiber.await(original)), Effect.asVoid),
        )
        yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"))
        expect((yield* admit(id, Effect.void).pipe(Effect.flip)).reason).toBe("task-concurrent")
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(original)
        yield* admit(id, Effect.void)
        const ready = yield* Deferred.make<void>()
        const blocked = yield* admit(id, Deferred.succeed(ready, undefined).pipe(Effect.andThen(Effect.never))).pipe(
          Effect.forkChild,
        )
        yield* Effect.addFinalizer(() => Fiber.interrupt(blocked).pipe(Effect.asVoid))
        yield* Deferred.await(ready).pipe(Effect.timeout("5 seconds"))
        yield* Fiber.interrupt(blocked)
        yield* admit(id, Effect.void)
        expect(yield* admit(id, Effect.fail("actual failure")).pipe(Effect.flip)).toBe("actual failure")
        yield* admit(id, Effect.void)
      }),
    ),
  )
})

test("producer port acknowledges the exact collision but retains an unclassified invariant error", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const port = SessionRetirement.make()
        const id = `retirement-${crypto.randomUUID()}`
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const original = yield* port.fork(() =>
          admit(id, Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))),
        )
        yield* Effect.addFinalizer(() =>
          Deferred.succeed(release, undefined).pipe(Effect.andThen(Fiber.await(original)), Effect.asVoid),
        )
        yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"))
        const collision = yield* port.tool("parent", "collision", admit(id, Effect.void)).pipe(Effect.exit)
        if (Exit.isSuccess(collision)) throw new Error("Collision unexpectedly succeeded")
        const error = Cause.squash(collision.cause)
        expect(error).toBeInstanceOf(Refusal)
        expect(port.completed("parent", "collision", new Error("different error"))).toBe(false)
        expect(port.completed("parent", "collision", error)).toBe(true)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(original)
        yield* port.drain
        expect(port.snapshot().active).toBe(0)
        const strict = SessionRetirement.make()
        const malformed = new Error("Result contract child input differs")
        yield* strict.tool("parent", "malformed", admit(id, Effect.die(malformed))).pipe(Effect.exit)
        const drained = yield* strict.drain.pipe(Effect.exit)
        expect(Exit.isFailure(drained)).toBe(true)
        if (Exit.isFailure(drained)) expect(Cause.squash(drained.cause)).toBe(malformed)
        yield* admit(id, Effect.void)
      }),
    ),
  )
})
