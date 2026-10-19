import { afterAll, beforeAll, expect } from "bun:test"
import { createHash } from "node:crypto"
import { realpath } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { RayaGoal } from "@/kilocode/goal"
import { KiloSession } from "@/kilocode/session"
import { RayaTaskRunner } from "@/kilocode/task/runner"
import { RayaTaskSnapshot } from "@/kilocode/task/snapshot"
import { Instruction } from "@/session/instruction"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { LSP } from "@/lsp/lsp"
import { MessageID, PartID } from "@/session/schema"
import { Session } from "@/session/session"
import { Storage } from "@/storage/storage"
import { ReadTool } from "@/tool/read"
import { Truncate } from "@/tool/truncate"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { testEffect, pollWithTimeout } from "../lib/effect"
import { testProviderConfig } from "../lib/test-provider"
import { TestInstance } from "../fixture/fixture"
import { remove as cleanup } from "./cleanup"

const db = path.join(os.tmpdir(), `raya-final-bootstrap-${process.pid}-${crypto.randomUUID()}.sqlite`)
const platform = process.env.KILO_PLATFORM
const aperture = process.env.APERTIS_BASE_URL
const credential = process.env.APERTIS_API_KEY
beforeAll(() => {
  process.env.KILO_PLATFORM = "vscode"
  process.env.APERTIS_BASE_URL = `http://127.0.0.1:${trap.port}/catalog`
  delete process.env.APERTIS_API_KEY
})
afterAll(async () => {
  if (platform === undefined) delete process.env.KILO_PLATFORM
  else process.env.KILO_PLATFORM = platform
  if (aperture === undefined) delete process.env.APERTIS_BASE_URL
  else process.env.APERTIS_BASE_URL = aperture
  if (credential === undefined) delete process.env.APERTIS_API_KEY
  else process.env.APERTIS_API_KEY = credential
  await Promise.all([db, `${db}-wal`, `${db}-shm`].map(cleanup))
}, 30_000)

// Real bootstrap is the boundary under test. FSUtil must come from its declared
// production dependencies, never a root service supplied by this test.
const app = AppNodeBuilder.build(
  LayerNode.group([
    InstanceStore.node,
    Session.node,
    SessionProjector.node,
    Storage.node,
    Database.node,
    Bus.node,
    CrossSpawnSpawner.node,
  ]),
  [
    [Database.node, Database.layerFromPath(db)],
    [InstanceStore.bootstrapNode, InstanceBootstrap.node],
  ],
)
const it = testEffect(app.pipe(Layer.provide(RuntimeFlags.layer())))
const reading = AppNodeBuilder.build(
  LayerNode.group([
    Agent.node,
    FSUtil.node,
    Instruction.node,
    LSP.node,
    Truncate.node,
    CrossSpawnSpawner.node,
    Ripgrep.node,
  ]),
)
const ref = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }
const text = "Exact original bootstrap source.\r\n"
const digest = (value: string) => createHash("sha256").update(value).digest("hex")
const attempts: { method: string; path: string }[] = []
const trap = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const route = new URL(request.url).pathname
    if (request.method === "GET" && route === "/catalog/models") return Response.json({ data: [] })
    attempts.push({ method: request.method, path: route })
    return Response.json({ error: "Inference is forbidden in this bootstrap regression" }, { status: 503 })
  },
})
afterAll(() => trap.stop(true))

for (const mode of ["exact", "changed", "started"] as const)
  it.instance(
    `production bootstrap TurnClose ${mode === "started" ? "started dispatch settles its original final" : `finished dispatch ${mode === "changed" ? "refuses a changed source" : "verifies an exact original final"}`} without inference`,
    () =>
      Effect.gen(function* () {
        const changed = mode === "changed"
        const instance = yield* TestInstance
        const context = yield* InstanceState.context
        const file = path.join(instance.directory, "approved.txt")
        yield* Effect.promise(() => Bun.write(file, text))
        const contract = {
          kind: "file" as const,
          path: yield* Effect.promise(() => realpath(file)),
          bytes: Buffer.byteLength(text),
          sha256: digest(text),
        }
        const storage = yield* Storage.Service
        const database = yield* Database.Service
        const sessions = yield* Session.Service
        const bus = yield* Bus.Service
        const goals = RayaGoal.make({ storage, sessions })
        const runner = RayaTaskRunner.make({ storage, database, sessions })
        const agent = yield* runner.tasks.create({
          name: "Bootstrap delivery",
          objective: "Return the approved source",
          schedule: { kind: "manual" },
          enabled: false,
          access: "brief",
          tools: ["read"],
          memoryScope: "session",
          dir: instance.directory,
          output: {
            destination: "conversation",
            description: "Exact original source",
            criteria: [{ id: "exact", description: "Exact bytes", verification: "Verify original final bytes" }],
            final: contract,
          },
        })
        const id = crypto.randomUUID()
        const trigger = { kind: "manual" as const }
        const chat = yield* sessions.create({
          metadata: {
            private: true,
            capture: false,
            rayaRoutine: {
              version: 2,
              agentID: agent.id,
              runID: id,
              scheduleVersion: agent.scheduleVersion ?? 1,
              trigger,
            },
          },
        })
        expect((yield* sessions.get(chat.id)).metadata).toMatchObject({ private: true, capture: false })
        // Match native Routine intake: arm an unset anchor, then publish its actual
        // post-goal root input before initial() binds the dispatch.
        const created = yield* goals.create(
          chat.id,
          agent.objective,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { agentID: agent.id, runID: id, sessionID: chat.id },
        )
        const user = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: chat.id,
          role: "user",
          agent: "build",
          model: ref,
          time: { created: Math.max(Date.now(), created.createdAt) },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: chat.id,
          messageID: user.id,
          type: "text",
          text: "Return the approved source exactly.",
        })
        const active = yield* goals.initial(chat.id, created.intent!, "bootstrap-delivery")
        if (!active?.dispatch) throw new Error("Original production Goal dispatch required")
        expect(user.time.created).toBeGreaterThanOrEqual(created.createdAt)
        expect(active.dispatch.messageID).toBe(user.id)
        const source = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: chat.id,
          role: "assistant",
          parentID: user.id,
          agent: "build",
          mode: "build",
          modelID: ref.modelID,
          providerID: ref.providerID,
          path: { cwd: instance.directory, root: instance.directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: Date.now() },
          finish: "tool-calls",
        })
        // Separate tool scope: genuine Read metadata, without supplying FSUtil to
        // the already-created bootstrap cache or its detached callback bridge.
        const result = yield* Effect.gen(function* () {
          const reader = yield* (yield* ReadTool).init()
          return yield* reader.execute(
            { filePath: file },
            {
              sessionID: chat.id,
              messageID: source.id,
              callID: "bootstrap-read",
              agent: "build",
              abort: AbortSignal.any([]),
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
        }).pipe(Effect.provideService(InstanceRef, context), Effect.provide(reading))
        expect((result.metadata as Record<string, unknown>).rayaReadContent).toMatchObject({
          complete: true,
          sha256: contract.sha256,
        })
        const action = yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: chat.id,
          messageID: source.id,
          type: "tool",
          callID: "bootstrap-read",
          tool: "read",
          state: {
            status: "completed",
            input: { filePath: file },
            title: result.title,
            output: result.output,
            metadata: result.metadata,
            time: { start: source.time.created, end: Date.now() },
          },
        })
        yield* sessions.updateMessage({ ...source, time: { ...source.time, completed: Date.now() } })
        const at = Date.now()
        const answer = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: chat.id,
          role: "assistant",
          parentID: user.id,
          agent: "build",
          mode: "build",
          modelID: ref.modelID,
          providerID: ref.providerID,
          path: { cwd: instance.directory, root: instance.directory },
          cost: 0,
          tokens: { input: 0, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: at, completed: at },
          finish: "stop",
        })
        const part = yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: chat.id,
          messageID: answer.id,
          type: "text",
          text,
        })
        // Accepted work audit is deliberately distinct from final delivery.
        yield* storage.replace(["raya", "goal", chat.id], {
          ...active,
          status: "complete",
          activeAt: undefined,
          audit: { summary: "Earlier work audit", verifiedAt: at, requirements: [] },
        })
        const run = yield* runner.tasks.record({
          id,
          agentID: agent.id,
          sessionID: chat.id,
          at: created.createdAt,
          status: "running",
          goalCreatedAt: created.createdAt,
          scheduleVersion: agent.scheduleVersion ?? 1,
          trigger,
        })
        yield* RayaTaskSnapshot.make({ storage }).save({
          version: 2,
          runID: id,
          agentID: agent.id,
          sessionID: chat.id,
          at: run.at,
          definition: agent,
          objective: agent.objective,
        })
        if (mode !== "started") {
          const finished = yield* goals.finished(chat.id, answer.id)
          expect(finished?.dispatch).toMatchObject({ phase: "finished", assistantID: answer.id })
        }
        const original = yield* goals.get(chat.id)
        const before = yield* sessions.messages({ sessionID: chat.id })
        if (changed) yield* Effect.promise(() => Bun.write(file, "changed after the genuine Read"))
        yield* bus.publish(KiloSession.Event.TurnClose, {
          sessionID: chat.id,
          messageID: answer.id,
          goalIntent: created.intent,
          reason: "completed",
        })
        const settled = yield* pollWithTimeout(
          runner.tasks
            .runsFor(agent.id)
            .pipe(Effect.map((rows) => rows.find((row) => row.id === id && row.outcome?.delivery !== undefined))),
          "Production bootstrap callback did not publish an original delivery result",
          "15 seconds",
        ).pipe(
          Effect.catch((err) =>
            Effect.gen(function* () {
              const current = yield* goals.get(chat.id)
              const history = yield* runner.tasks.runsFor(agent.id)
              return yield* Effect.fail(
                new Error(
                  `${err.message}; original Goal=${JSON.stringify(original)}; current Goal=${JSON.stringify(current)}; Run=${JSON.stringify(history.find((row) => row.id === id))}`,
                ),
              )
            }),
          ),
        )
        expect(settled.trace?.goalCreatedAt).toBe(created.createdAt)
        expect(
          settled.trace?.turns.some((turn) =>
            turn.messages.some(
              (message) =>
                message.messageID === source.id &&
                message.actions.some((entry) => entry.actionID === action.id && entry.status === "completed"),
            ),
          ),
        ).toBe(true)
        expect(settled.outcome?.report).toMatchObject({
          messageID: answer.id,
          parentID: user.id,
          partIDs: [part.id],
          sha256: digest(text),
        })
        expect(settled.outcome?.summary).toBe(text)
        expect(settled.outcome?.delivery?.status).toBe(changed ? "unavailable" : "passed")
        expect(settled.status).toBe(changed ? "blocked" : "complete")
        expect(yield* sessions.messages({ sessionID: chat.id })).toEqual(before)
        expect(attempts).toEqual([])
      }),
    {
      git: true,
      config: () => ({
        ...testProviderConfig(`http://127.0.0.1:${trap.port}/v1`),
        provider: {
          ...testProviderConfig(`http://127.0.0.1:${trap.port}/v1`).provider,
          apertis: { options: { apiKey: "test-catalog-only", baseURL: `http://127.0.0.1:${trap.port}/catalog` } },
        },
        enabled_providers: ["test"],
        model: "test/test-model",
        small_model: "test/test-model",
        raya_routing: { goal_continuation: false },
      }),
    },
    60_000,
  )
