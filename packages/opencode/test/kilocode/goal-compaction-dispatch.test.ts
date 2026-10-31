import { expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { database, storage } from "./fixtures/effect-profile"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { InputReceipt } from "@opencode-ai/core/kilocode/input-receipt"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { RayaGoal } from "@/kilocode/goal"
import { replayed, usage } from "@/kilocode/goal/compaction-lineage"
import * as Accounting from "@/kilocode/goal/accounting"
import { collect } from "@/kilocode/goal/evidence-scope"
import { associate, compaction } from "@/kilocode/goal/turn"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      Storage.node,
      Database.node,
      FSUtil.node,
      CrossSpawnSpawner.node,
    ]),
    [
      [Database.node, database],
      [Storage.node, storage],
    ],
  ),
)

it.live(
  "stage reminders preserve ordinary chat and legacy routine compaction behavior",
  () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const storage = yield* Storage.Service
        const goals = RayaGoal.make({ storage, sessions })
        const remind = yield* compaction
        const ordinary = yield* sessions.create({})
        expect(yield* remind(ordinary, [])).toBeUndefined()
        const identity = {
          version: 2,
          agentID: "legacy-worker",
          runID: "legacy-run",
          scheduleVersion: 1,
          trigger: { kind: "manual" },
        }
        const chat = yield* sessions.create({ metadata: { rayaRoutine: identity } })
        yield* Effect.addFinalizer(() => goals.clear(chat.id))
        const goal = yield* goals.create(
          chat.id,
          "Retain the original legacy job",
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { agentID: identity.agentID, runID: identity.runID, sessionID: chat.id },
        )
        expect(yield* remind(chat, [])).toBeUndefined()
        const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") }
        const user = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: chat.id,
          role: "user",
          agent: "coder",
          model,
          time: { created: Date.now() },
        })
        const part = yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: user.id,
          sessionID: chat.id,
          type: "text",
          synthetic: true,
          metadata: { compaction_continue: true },
          text: "Continue the existing job.",
        })
        const text = yield* remind(chat, [part])
        expect(text).toContain("This routine resumed after conversation compaction with an active saved goal.")
        expect(text).not.toContain("Current authenticated Routine stage")
        expect(yield* goals.get(chat.id)).toEqual(goal)
      }),
    ),
)

it.live(
  "repeated native compaction preserves and closes the original goal dispatch",
  () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const storage = yield* Storage.Service
          const runs = yield* SessionRunState.Service
          const goals = RayaGoal.make({ storage, sessions })
          const chat = yield* sessions.create({})
          yield* Effect.addFinalizer(() => goals.clear(chat.id))
          const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") }
          const user = () =>
            sessions.updateMessage({
              id: MessageID.ascending(),
              sessionID: chat.id,
              role: "user",
              agent: "coder",
              model,
              time: { created: Date.now() },
            })
          const reply = (parentID: MessageID, summary = false) =>
            sessions.updateMessage({
              id: MessageID.ascending(),
              sessionID: chat.id,
              role: "assistant",
              parentID,
              agent: summary ? "compaction" : "coder",
              mode: summary ? "compaction" : "coder",
              summary: summary || undefined,
              modelID: model.modelID,
              providerID: model.providerID,
              path: { cwd: chat.directory, root: chat.directory },
              cost: summary ? 0.25 : 0,
              tokens: summary
                ? { input: 11, output: 5, reasoning: 2, cache: { read: 3, write: 1 } }
                : { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              finish: "stop",
              time: { created: Date.now(), completed: Date.now() },
            })
          const original = yield* user()
          const part = yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: original.id,
            sessionID: chat.id,
            type: "text",
            synthetic: true,
            text: "Continue the saved local job; wait for the actual Sales reply before completion.",
          })
          yield* sessions.updatePart(InputReceipt.seal(original, [part])!)
          const assistant = yield* reply(original.id)
          yield* goals.create(chat.id, "Finish the original local job", original.id)
          yield* runs.ensureRunning(
            chat.id,
            Effect.succeed({ info: assistant, parts: [] }),
            Effect.gen(function* () {
              yield* associate(goals, runs, chat.id, sessions)
              const armed = (yield* goals.get(chat.id))!
              expect(armed.dispatch?.worker).toBeString()
              const compact = () =>
                Effect.gen(function* () {
                  const marker = yield* user()
                  yield* sessions.updatePart({
                    id: PartID.ascending(),
                    messageID: marker.id,
                    sessionID: chat.id,
                    type: "compaction",
                    auto: true,
                    overflow: false,
                  })
                  const summary = yield* reply(marker.id, true)
                  yield* sessions.updatePart({
                    id: PartID.ascending(),
                    messageID: summary.id,
                    sessionID: chat.id,
                    type: "text",
                    text: "Actual persisted compaction summary.",
                  })
                  const intake = yield* user()
                  const source = (yield* sessions.messages({ sessionID: chat.id })).find(
                    (row) => row.info.id === original.id,
                  )!
                  for (const part of source.parts)
                    yield* sessions.updatePart({ ...part, id: PartID.ascending(), messageID: intake.id })
                  const response = yield* reply(intake.id)
                  return { intake, response, marker, summary }
                })
              const first = yield* compact()
              yield* associate(goals, runs, chat.id, sessions)
              expect((yield* goals.get(chat.id))?.dispatch?.messageID).toBe(first.intake.id)
              const second = yield* compact()
              const prior = (yield* goals.get(chat.id))!
              const rows = yield* sessions.messages({ sessionID: chat.id })
              const session = yield* sessions.get(chat.id)
              const worker = prior.dispatch!.worker!
              expect(replayed(rows, session, prior, second.intake.id, worker)).toBe(true)
              expect(replayed(rows.toReversed(), session, prior, second.intake.id, worker)).toBe(false)
              expect(replayed(rows, session, { ...prior, status: "paused" }, second.intake.id, worker)).toBe(false)
              expect(replayed(rows, session, { ...prior, intent: crypto.randomUUID() }, second.intake.id, worker)).toBe(
                false,
              )
              expect(replayed(rows, session, prior, second.intake.id, crypto.randomUUID())).toBe(false)
              expect(
                replayed(
                  rows.filter((row) => row.info.id !== second.marker.id),
                  session,
                  prior,
                  second.intake.id,
                  worker,
                ),
              ).toBe(false)
              const foreign = rows.map((row) =>
                row.info.id === second.intake.id
                  ? { ...row, info: { ...row.info, sessionID: SessionID.make("ses_foreign") } }
                  : row,
              )
              expect(replayed(foreign, session, prior, second.intake.id, worker)).toBe(false)
              const forged = rows.map((row) =>
                row.info.id === original.id
                  ? {
                      ...row,
                      parts: row.parts.map((part) =>
                        part.type === "text" ? { ...part, text: "Changed sealed source" } : part,
                      ),
                    }
                  : row,
              )
              expect(replayed(forged, session, prior, second.intake.id, worker)).toBe(false)
              const manual = rows.map((row) =>
                row.info.id === second.marker.id
                  ? {
                      ...row,
                      parts: row.parts.map((part) => (part.type === "compaction" ? { ...part, auto: false } : part)),
                    }
                  : row,
              )
              expect(replayed(manual, session, prior, second.intake.id, worker)).toBe(false)
              yield* sessions.updateMessage({ ...second.intake, system: "New unauthorized instruction" })
              yield* associate(goals, runs, chat.id, sessions)
              expect((yield* goals.get(chat.id))?.dispatch?.messageID).toBe(first.intake.id)
              yield* sessions.updateMessage(second.intake)
              yield* associate(goals, runs, chat.id, sessions)
              const followed = (yield* goals.get(chat.id))!
              expect(followed.dispatch?.messageID).toBe(second.intake.id)
              expect(followed.dispatch?.id).toBe(armed.dispatch?.id)
              expect(followed.dispatch?.worker).toBe(armed.dispatch?.worker)
              expect(followed.dispatch?.startedAt).toBe(armed.dispatch?.startedAt)
              expect(followed.intent).toBe(armed.intent)
              expect(followed.inputs).toContain(original.id)
              expect(followed.inputs).toContain(first.intake.id)
              const summaries = usage(rows, session, followed)
              expect(summaries.map((row) => row.id)).toEqual([first.summary.id, second.summary.id])
              expect(usage(foreign, session, followed)).toEqual([])
              expect(usage(forged, session, followed)).toEqual([])
              const unmarked = rows.map((row) =>
                row.info.id === second.summary.id ? { ...row, info: { ...row.info, summary: false } } : row,
              )
              expect(usage(unmarked, session, followed).map((row) => row.id)).toEqual([first.summary.id])
              expect(usage(rows, session, { ...followed, createdAt: Date.now() + 1 })).toEqual([])
              expect(usage(manual, session, followed).map((row) => row.id)).toEqual([first.summary.id])
              expect(usage(rows, session, { ...followed, intent: crypto.randomUUID() })).toEqual([])
              const graph = yield* collect(sessions, chat.id, followed.createdAt, followed.inputs, rows)
              expect(graph.some((row) => row.info.role === "assistant" && row.info.summary)).toBe(false)
              expect(Accounting.sum(graph, chat.id).tokens.input).toBe(0)
              expect(Accounting.sum(graph, chat.id, [...summaries, ...summaries]).tokens.input).toBe(22)
              const recorded = yield* goals.recordTurn(chat.id, second.response.id, followed.intent)
              expect(recorded?.state.usage.tokens).toEqual({
                input: 22,
                output: 10,
                reasoning: 4,
                cache: { read: 6, write: 2 },
              })
              expect(recorded?.state.usage.cost).toBe(0.5)
              expect(recorded?.state.usage.toolCalls).toBe(0)
              expect(yield* goals.recordTurn(chat.id, second.response.id, followed.intent)).toBeUndefined()
              expect(yield* goals.get(chat.id)).toEqual(recorded?.state)
              expect((yield* goals.finished(chat.id, second.response.id))?.dispatch?.phase).toBe("finished")
              const queued = yield* goals.continued(chat.id, followed.intent)
              expect(queued?.dispatch?.phase).toBe("queued")
              if (!queued?.dispatch) throw new Error("Expected next native dispatch")
              const started = yield* goals.dispatched(chat.id, queued.dispatch.id)
              if (!started?.dispatch?.messageID) throw new Error("Expected reserved native input")
              const intake = yield* sessions.updateMessage({
                id: started.dispatch.messageID,
                sessionID: chat.id,
                role: "user",
                agent: "coder",
                model,
                time: { created: Date.now() },
              })
              const part = yield* sessions.updatePart({
                id: PartID.ascending(),
                messageID: intake.id,
                sessionID: chat.id,
                type: "text",
                synthetic: true,
                text: "Continue this same Goal after the accounted compactions.",
              })
              yield* sessions.updatePart(InputReceipt.seal(intake, [part])!)
              yield* goals.bound(chat.id, started.dispatch.id, worker)
              const response = yield* reply(intake.id)
              const later = yield* goals.recordTurn(chat.id, response.id, followed.intent)
              expect(later?.state.usage.tokens).toEqual(recorded?.state.usage.tokens)
              expect(later?.state.usage.cost).toBe(0.5)
              expect(later?.state.usage.turns).toBe(2)
              expect(yield* goals.recordTurn(chat.id, response.id, followed.intent)).toBeUndefined()
              expect((yield* goals.finished(chat.id, response.id))?.dispatch?.phase).toBe("finished")
              return { info: response, parts: [] }
            }).pipe(Effect.orDie),
          )
        }),
      { config: { enabled_providers: [], formatter: false, lsp: false, indexing: { enabled: false } } },
    ),
  20_000,
)
