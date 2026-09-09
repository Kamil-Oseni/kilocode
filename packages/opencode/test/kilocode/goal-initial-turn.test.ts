import { expect } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Git } from "@/git"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Storage } from "@/storage/storage"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { MessageID } from "@/session/schema"
import { SessionRunState } from "@/session/run-state"
import { ToolRegistry } from "@/tool/registry"
import { RayaGoal } from "@/kilocode/goal"
import { binding } from "@/kilocode/goal/turn"
import * as TaskWorker from "@/kilocode/session/task-worker"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

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
  "registered goal plan tool persists updates and rejects stale writes",
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
          const saved = yield* tool.execute(input, ctx)
          expect(saved.title).toBe("Goal plan saved")
          expect((yield* goals.get(session.id))?.plan?.tasks[0].id).toBe("verify")
          const rejected = yield* tool.execute(input, ctx)
          expect(rejected.title).toBe("Goal plan not saved")
          expect(rejected.output).toContain("changed")
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
