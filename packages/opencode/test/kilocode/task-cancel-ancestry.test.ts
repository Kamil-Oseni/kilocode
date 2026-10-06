import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { Permission } from "@/permission"
import { Question } from "@/question"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { expect } from "bun:test"
import { Deferred, Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { SessionRunState } from "@/session/run-state"
import * as TaskWorker from "@/kilocode/session/task-worker"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import { Provider } from "@/provider/provider"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"

const model = ProviderTest.model()
const provider = ProviderTest.fake({ model })
const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      Session.node,
      SessionRunState.node,
      TaskWorker.node,
      Provider.node,
      RuntimeFlags.node,
      Database.node,
      Config.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      Truncate.node,
      ToolRegistry.node,
      Permission.node,
      Question.node,
      Ripgrep.node,
    ]),
    [[Provider.node, provider.layer]],
  ),
)

it.instance(
  "real Task dispatch binds both prompt runners and joins the original detached descendant",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const jobs = yield* BackgroundJob.Service
      const runs = yield* SessionRunState.Service
      const workers = yield* TaskWorker.Service
      const root = yield* sessions.create({ title: "parent" })
      const user = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: root.id,
        agent: "build",
        model: { providerID: model.providerID, modelID: model.id },
        time: { created: Date.now() },
      })
      const reply = (session: typeof root.id, parent: typeof user.id): SessionV1.WithParts => ({
        info: {
          id: MessageID.ascending(),
          role: "assistant",
          sessionID: session,
          parentID: parent,
          agent: "general",
          mode: "general",
          cost: 0,
          path: { cwd: "/private", root: "/private" },
          modelID: model.id,
          providerID: model.providerID,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: Date.now() },
          finish: "stop",
        },
        parts: [],
      })
      const assistant = reply(root.id, user.id)
      yield* sessions.updateMessage(assistant.info)
      const def = yield* (yield* TaskTool).init()
      const ready = yield* Deferred.make<SessionID>()
      const nested = yield* Deferred.make<void>()
      const stopped = yield* Deferred.make<void>()
      const parent = yield* Deferred.make<void>()
      const ops: TaskPromptOps = {
        cancel: (session, message) =>
          message ? workers.cancel(session, message).pipe(Effect.asVoid) : Effect.die(new Error("missing exact input")),
        resolvePromptParts: (text) => Effect.succeed([{ type: "text", text }]),
        prompt: (input) =>
          Effect.gen(function* () {
            if (!input.messageID) return yield* Effect.die(new Error("actual Task input required"))
            const message = input.messageID
            const result = reply(input.sessionID, message)
            return yield* runs.ensureRunning(
              input.sessionID,
              Effect.succeed(result),
              Effect.gen(function* () {
                expect(yield* workers.bind(input.sessionID, message)).toBe(true)
                expect((yield* workers.current)?.messageID).toBe(message)
                if (input.sessionID !== child) {
                  yield* Deferred.succeed(nested, undefined)
                  return yield* Effect.never.pipe(Effect.ensuring(Deferred.succeed(stopped, undefined)))
                }
                yield* sessions.updateMessage(result.info)
                const count = (yield* jobs.list()).length
                const refused = yield* Effect.exit(
                  def.execute(
                    { prompt: "Foreign context must not create a child", subagent_type: "general", background: true },
                    {
                      sessionID: root.id,
                      messageID: result.info.id,
                      callID: "foreign-call",
                      agent: "general",
                      abort: new AbortController().signal,
                      messages: [],
                      extra: { promptOps: ops },
                      metadata: () => Effect.void,
                      ask: () => Effect.void,
                    },
                  ),
                )
                expect(Exit.isFailure(refused)).toBe(true)
                expect((yield* jobs.list()).length).toBe(count)
                const descendant = yield* def.execute(
                  { prompt: "Perform independent assigned work", subagent_type: "general", background: true },
                  {
                    sessionID: input.sessionID,
                    messageID: result.info.id,
                    callID: "nested-call",
                    agent: "general",
                    abort: new AbortController().signal,
                    messages: [],
                    extra: { promptOps: ops },
                    metadata: () => Effect.void,
                    ask: () => Effect.void,
                  },
                )
                yield* Deferred.succeed(ready, descendant.metadata.sessionId)
                return yield* Effect.never.pipe(Effect.ensuring(Deferred.succeed(parent, undefined)))
              }).pipe(Effect.ensuring(workers.release)),
            )
          }),
      }
      // The first prompt is gated until the original Task result has named its child.
      const opened = yield* Deferred.make<void>()
      const gated: TaskPromptOps = {
        ...ops,
        prompt: (input) => Deferred.await(opened).pipe(Effect.andThen(ops.prompt(input))),
      }
      const dispatched = yield* def.execute(
        { prompt: "Perform the parent task", subagent_type: "general", background: true },
        {
          sessionID: root.id,
          messageID: assistant.info.id,
          callID: "root-call",
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          extra: { promptOps: gated },
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      const child = dispatched.metadata.sessionId
      yield* Deferred.succeed(opened, undefined)
      const id = yield* Deferred.await(ready)
      yield* Deferred.await(nested)
      const selected = yield* jobs.get(child)
      if (!selected?.revision) throw new Error("selected revision required")
      expect(yield* jobs.cancelTree(child, selected.revision)).toBe("cancelled")
      expect(yield* Deferred.isDone(parent)).toBe(true)
      expect(yield* Deferred.isDone(stopped)).toBe(true)
      expect((yield* jobs.get(id))?.status).toBe("cancelled")
      expect((yield* runs.inspect(child)).phase).toBe("idle")
      expect((yield* runs.inspect(id)).phase).toBe("idle")
    }),
  { git: false, config: { formatter: false, lsp: false, mcp: {}, plugin: [] } },
  20000,
)
