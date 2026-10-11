import { afterEach, expect } from "bun:test"
import path from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { Storage } from "@/storage/storage"
import { Git } from "@/git"
import { BackgroundJob } from "@/background/job"
import { MessageID, PartID } from "@/session/schema"
import { RayaChief } from "@/kilocode/chief"
import { ResultContract } from "@/kilocode/chief/result-contract"
import { RayaGoal } from "@/kilocode/goal"
import * as GoalInput from "@/kilocode/goal/task-input"
import { TaskName } from "@/kilocode/tool/task-name"
import { testEffect } from "../lib/effect"
import { disposeAllInstances, provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"

afterEach(disposeAllInstances)
const graph = LayerNode.group([
  Session.node,
  SessionProjector.node,
  Storage.node,
  Database.node,
  FSUtil.node,
  Git.node,
  CrossSpawnSpawner.node,
  BackgroundJob.node,
  SessionRunState.node,
])
const it = testEffect(Layer.mergeAll(LayerNode.compile(graph), testInstanceStoreLayer))
const model = { providerID: ProviderV2.ID.make("fixture"), modelID: ModelV2.ID.make("fixture") }

it.live("an original unpublished result notice refuses a same-objective replacement goal", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    yield* provideInstance(dir)(
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const storage = yield* Storage.Service
        const background = yield* BackgroundJob.Service
        const runs = yield* SessionRunState.Service
        const goals = RayaGoal.make({ storage, sessions })
        const root = yield* sessions.create({ title: "Original notice goal" })
        const user = MessageID.ascending()
        const message = MessageID.ascending()
        const request = "Explain the original completed local work"
        const decision: RayaChief.Decision = {
          request,
          access: "read",
          result: "narrative",
          userID: user,
          agent: "generalist",
          model: "fixture/fixture",
          needs_plan: false,
          confidence: 1,
          reason: "Persisted notice fixture",
          latency: 0,
          chiefModel: "fixture/fixture",
          candidates: [],
          prompted: false,
        }
        yield* sessions.updateMessage({
          id: user,
          sessionID: root.id,
          role: "user",
          agent: "auto",
          model,
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: user,
          sessionID: root.id,
          type: "text",
          text: request,
        })
        const assistant = yield* sessions.updateMessage({
          id: message,
          sessionID: root.id,
          role: "assistant",
          parentID: user,
          agent: "auto",
          mode: "auto",
          providerID: model.providerID,
          modelID: model.modelID,
          cost: 0,
          path: { cwd: dir, root: dir },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: Date.now() },
        })
        yield* sessions.setMetadata({
          sessionID: root.id,
          metadata: {
            [RayaChief.requestKey]: request,
            [RayaChief.phaseKey]: "task",
            [RayaChief.logKey]: [decision],
          },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: message,
          sessionID: root.id,
          type: "tool",
          tool: "chief_route",
          callID: "original-route",
          state: {
            status: "completed",
            input: { access: "read", result: "narrative", objective: request },
            title: "Original route",
            output: JSON.stringify(decision),
            metadata: {},
            time: { start: assistant.time.created, end: Date.now() },
          },
        })
        const value = yield* ResultContract.load(sessions, root.id)
        if (!value) throw new Error("Actual saved route proof absent")
        const original = yield* goals.create(root.id, request, message)
        if (!original.intent) throw new Error("Actual original goal intent absent")
        const stamp = yield* GoalInput.stamp(storage, root.id)
        expect(stamp[GoalInput.key]?.intent).toBe(original.intent)
        const child = yield* sessions.create({ parentID: root.id, title: "Original background producer" })
        const input = MessageID.ascending()
        const call = "original-background"
        const owner: TaskName.Identity = {
          version: 1,
          displayName: "Original background producer",
          baseName: "Original background producer",
          ordinal: 1,
          specialist: "generalist",
          selection: "auto",
          provenance: { source: "objective", parentSessionID: root.id, parentMessageID: message, callID: call },
        }
        yield* sessions.setMetadata({
          sessionID: child.id,
          metadata: {
            [TaskName.key]: owner,
            [ResultContract.key]: ResultContract.child(value, {
              sessionID: child.id,
              inputID: input,
              parentMessageID: message,
              callID: call,
            }),
          },
        })
        yield* sessions.updateMessage({
          id: input,
          sessionID: child.id,
          role: "user",
          agent: "generalist",
          model,
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: child.id,
          messageID: input,
          type: "text",
          text: request,
        })
        const start = Date.now()
        const part = PartID.ascending()
        yield* sessions.updatePart({
          id: part,
          sessionID: root.id,
          messageID: message,
          type: "tool",
          tool: "task",
          callID: call,
          state: {
            status: "completed",
            input: { access: "read", prompt: request, background: true },
            title: "Original background",
            output: "Original background admitted",
            metadata: {
              parentSessionId: root.id,
              sessionId: child.id,
              childMessageID: input,
              background: true,
              jobId: child.id,
              ...stamp,
            },
            time: { start, end: Date.now() },
          },
        })
        const job = yield* background.start({
          id: child.id,
          type: "task",
          origin: {
            sessionID: root.id,
            messageID: message,
            callID: call,
            childSessionID: child.id,
            childMessageID: input,
          },
          run: Effect.gen(function* () {
            const terminal = MessageID.ascending()
            yield* sessions.updateMessage({
              id: terminal,
              sessionID: child.id,
              parentID: input,
              role: "assistant",
              agent: "generalist",
              mode: "generalist",
              providerID: model.providerID,
              modelID: model.modelID,
              cost: 0,
              path: { cwd: dir, root: dir },
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: Date.now(), completed: Date.now() },
              finish: "stop",
            })
            yield* sessions.updatePart({
              id: PartID.ascending(),
              sessionID: child.id,
              messageID: terminal,
              type: "text",
              text: "Actual original background completion",
            })
            return "Actual original background completion"
          }),
        })
        const completed = yield* background.wait({ id: job.id })
        expect(completed.timedOut).toBe(false)
        expect(completed.info?.status).toBe("completed")
        const text = completed.info?.output
        if (!text) throw new Error("Actual BackgroundJob outcome absent")
        const token = yield* ResultContract.notice(sessions, background, value, job.id, text, storage)
        const incoming = [{ type: "text", synthetic: true, text }]
        expect(yield* ResultContract.continuing(sessions, token, root.id, incoming)).toBe(request)
        yield* goals.stop(root.id, original.intent, runs)
        expect(yield* goals.get(root.id)).toBeUndefined()
        const replacement = yield* goals.create(root.id, request, message)
        expect(replacement.intent).not.toBe(original.intent)
        expect(replacement.objective).toBe(original.objective)
        const before = yield* sessions.get(root.id)
        const rows = yield* sessions.messages({ sessionID: root.id })
        const notice = MessageID.ascending()
        const row = {
          info: {
            id: notice,
            sessionID: root.id,
            role: "user" as const,
            agent: "auto",
            model,
            time: { created: Date.now() },
          },
          parts: [
            {
              id: PartID.ascending(),
              messageID: notice,
              sessionID: root.id,
              type: "text" as const,
              synthetic: true,
              text,
            },
          ],
        }
        const continued = yield* ResultContract.continuing(sessions, token, root.id, incoming).pipe(Effect.exit)
        const validated = yield* ResultContract.validateNotice(sessions, token, row).pipe(Effect.exit)
        if (!Exit.isFailure(continued) || !Exit.isFailure(validated))
          throw new Error("A replaced goal must refuse the original unpublished notice")
        expect(String(Cause.squash(continued.cause))).toContain("Result contract original goal changed")
        expect(String(Cause.squash(validated.cause))).toContain("Result contract original goal changed")
        expect(yield* goals.get(root.id)).toEqual(replacement)
        expect(yield* sessions.get(root.id)).toEqual(before)
        expect(yield* sessions.messages({ sessionID: root.id })).toEqual(rows)
        expect(RayaChief.phase(before.metadata)).toBe("task")
        expect(replacement.inputs).toEqual(original.inputs)
      }).pipe(
        Effect.provide(
          Layer.fresh(
            LayerNode.compile(graph, [
              [Database.node, Database.layerFromPath(path.join(dir, "notice.sqlite"))],
              [
                Storage.node,
                LayerNode.make({
                  service: Storage.Service,
                  layer: Storage.layerWithDatabase(path.join(dir, "storage")),
                  deps: [FSUtil.node, Git.node, Database.node],
                }),
              ],
            ]),
          ),
        ),
      ),
    )
  }),
)
