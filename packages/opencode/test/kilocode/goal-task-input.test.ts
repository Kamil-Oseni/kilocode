import { expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { MessageID, PartID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { Git } from "@/git"
import { Truncate } from "@/tool/truncate"
import { Agent } from "@/agent/agent"
import { RayaGoal } from "@/kilocode/goal"
import * as Artifact from "@/kilocode/goal/artifact"
import * as TaskWorker from "@/kilocode/session/task-worker"
import { associate } from "@/kilocode/goal/turn"
import { goalTools } from "@/kilocode/tool/goal"
import { stamp } from "@/kilocode/goal/task-input"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      TaskWorker.node,
      Storage.node,
      FSUtil.node,
      CrossSpawnSpawner.node,
      Git.node,
      Truncate.node,
      Agent.node,
    ]),
  ),
)

for (const mode of ["retained", "missing", "changed", "paused", "duplicate", "unbound", "legacy"] as const)
  it.live(
    `retained Task goal evidence: ${mode}`,
    () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const storage = yield* Storage.Service
            const runs = yield* SessionRunState.Service
            const workers = yield* TaskWorker.Service
            const fs = yield* FSUtil.Service
            const goals = RayaGoal.make({ storage, sessions })
            const parent = yield* sessions.create({})
            const child = yield* sessions.create({ parentID: parent.id })
            yield* Effect.addFinalizer(() => Effect.all([goals.clear(parent.id), goals.clear(child.id)]))
            const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") }
            const user = (sid: typeof parent.id) =>
              sessions.updateMessage({
                id: MessageID.ascending(),
                sessionID: sid,
                role: "user",
                agent: "code",
                model,
                time: { created: Date.now() },
              })
            const reply = (sid: typeof parent.id, input: MessageID) =>
              sessions.updateMessage({
                id: MessageID.ascending(),
                sessionID: sid,
                parentID: input,
                role: "assistant",
                agent: "code",
                mode: "code",
                path: { cwd: parent.directory, root: parent.directory },
                providerID: model.providerID,
                modelID: model.modelID,
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                time: { created: Date.now() },
              })
            const original = yield* user(parent.id)
            const caller = yield* reply(parent.id, original.id)
            yield* goals.create(parent.id, "Verify the authorized repair through this specialist", original.id)
            const first = yield* user(child.id)
            const initial = yield* reply(child.id, first.id)
            const receipt = (input: MessageID) =>
              Effect.gen(function* () {
                const scope = yield* stamp(storage, parent.id)
                const meta = mode === "legacy" ? {} : scope
                return yield* sessions.updatePart({
                  id: PartID.ascending(),
                  messageID: caller.id,
                  sessionID: parent.id,
                  type: "tool",
                  tool: "task",
                  callID: crypto.randomUUID(),
                  state: {
                    status: "running",
                    input: { task_id: child.id },
                    title: "retained specialist",
                    time: { start: Date.now() },
                    metadata: { parentSessionId: parent.id, sessionId: child.id, childMessageID: input, ...meta },
                  },
                })
              })
            yield* receipt(first.id)
            yield* runs.ensureRunning(
              child.id,
              Effect.succeed({ info: initial, parts: [] }),
              Effect.gen(function* () {
                expect(yield* workers.bind(child.id, first.id)).toBe(true)
                yield* goals.create(child.id, "Verify the authorized repaired file", initial.id)
                yield* associate(goals, runs, child.id)
                return { info: initial, parts: [] }
              }).pipe(Effect.orDie, Effect.ensuring(workers.release)),
            )
            const before = (yield* goals.get(child.id))!
            expect(before.inputs).toEqual([first.id])
            const next = yield* user(child.id)
            const assistant = yield* reply(child.id, next.id)
            if (mode !== "missing") yield* receipt(next.id)
            if (mode === "duplicate") yield* receipt(next.id)
            if (mode === "changed") yield* goals.revise(parent.id, "A different parent objective")
            if (mode === "paused") yield* goals.edit(child.id, { expectedIntent: before.intent, status: "paused" })
            const file = parent.directory + "/repaired.txt"
            yield* fs.writeFileString(file, "verified repair")
            const revision = yield* Artifact.capture(fs, file)
            const call = crypto.randomUUID()
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: assistant.id,
              sessionID: child.id,
              type: "tool",
              tool: "read",
              callID: call,
              state: {
                status: "completed",
                input: { filePath: file },
                title: "read",
                output: "verified repair",
                metadata: { rayaRevision: revision },
                time: { start: Date.now(), end: Date.now() },
              },
            })
            expect(yield* goals.evidence(child.id)).toEqual([])
            const get = yield* (yield* goalTools(goals, sessions, runs).get).init()
            yield* runs.ensureRunning(
              child.id,
              Effect.succeed({ info: assistant, parts: [] }),
              Effect.gen(function* () {
                if (mode !== "unbound") expect(yield* workers.bind(child.id, next.id)).toBe(true)
                const observed = JSON.parse(
                  (yield* get.execute(
                    {},
                    {
                      sessionID: child.id,
                      messageID: assistant.id,
                      agent: "code",
                      messages: [],
                      abort: AbortSignal.any([]),
                      metadata: () => Effect.void,
                      ask: () => Effect.die("Unexpected approval"),
                    },
                  )).output,
                )
                const saved = (yield* goals.get(child.id))!
                expect(saved.objective).toBe(before.objective)
                expect(saved.createdAt).toBe(before.createdAt)
                expect(saved.criteria).toEqual(before.criteria)
                if (mode === "retained") {
                  expect(saved.inputs).toEqual([first.id, next.id])
                  expect(saved.dispatch?.worker).toBe((yield* runs.inspect(child.id)).id)
                  expect(observed.eligibleEvidence.map((row: { callID: string }) => row.callID)).toEqual([call])
                  const completed = yield* goals.update(child.id, {
                    status: "complete",
                    requirements: [
                      {
                        requirement: "Verify the authorized repaired file",
                        passed: true,
                        evidence: [{ callID: call, summary: "Read the saved repair" }],
                      },
                    ],
                  })
                  expect(completed.status).toBe("complete")
                } else {
                  expect(saved.inputs).toEqual([first.id])
                  expect(observed.eligibleEvidence).toEqual([])
                }
                return { info: assistant, parts: [] }
              }).pipe(Effect.orDie, Effect.ensuring(workers.release)),
            )
          }),
        { git: true, config: { enabled_providers: [], formatter: false, lsp: false, indexing: { enabled: false } } },
      ),
    60_000,
  )
