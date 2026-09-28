import { expect } from "bun:test"
import path from "node:path"
import { createHash } from "node:crypto"
import { Deferred, Effect, Exit, Scope } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Git } from "@/git"
import { eq, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { NotFoundError } from "@/storage/storage"
import * as Store from "@/kilocode/voice/openai-store"
import { Storage } from "@/storage/storage"
import { Runner } from "@/effect/runner"
import { observe } from "@/kilocode/effect/observation"
import * as Workers from "@/kilocode/session/task-worker"
import { make, VoiceError } from "@/kilocode/voice/openai"
import { RayaGoal } from "@/kilocode/goal"
import * as GoalCharges from "@/kilocode/goal/charges"
import { pricing } from "@/kilocode/voice/live-protocol"
import type { OpenAICall } from "@/kilocode/voice/openai-protocol"
import type { SessionPrompt } from "@/session/prompt"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { RayaVoice } from "@/kilocode/voice/service"
import * as Session from "@/session/session"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))
const secret = "a".repeat(64)
const session = SessionID.make("ses_openai_voice_live")
type Prompt = Parameters<SessionPrompt.Interface["prompt"]>[0]

function answer(input: Prompt): MessageV2.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      sessionID: input.sessionID,
      parentID: input.messageID!,
      role: "assistant",
      agent: "code",
      mode: "code",
      time: { created: Date.now(), completed: Date.now() },
      path: { cwd: process.cwd(), root: process.cwd() },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      providerID: ProviderV2.ID.make("test"),
      modelID: ModelV2.ID.make("test"),
      finish: "stop",
    },
    parts: [
      { id: PartID.ascending(), messageID: id, sessionID: input.sessionID, type: "text", text: "Verified Live result" },
    ],
  }
}

const fixture = (
  root: string,
  model: "gpt-live-1" | "gpt-realtime-2.1" = "gpt-live-1",
  work: SessionPrompt.Interface["prompt"] = (input) => Effect.succeed(answer(input)),
  amount = 1,
  policy?: Pick<Parameters<typeof make>[0], "admissions" | "charges" | "completions">,
) =>
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const database = yield* Database.Service
    yield* database.db
      .run(
        sql`INSERT OR IGNORE INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('voice-project', ${root}, 1, 1, '[]')`,
      )
      .pipe(Effect.orDie)
    yield* database.db
      .run(
        sql`INSERT OR IGNORE INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (${session}, 'voice-project', 'voice', ${root}, 'Voice live test', 'test', 1, 1)`,
      )
      .pipe(Effect.orDie)
    const runner = Runner.make<MessageV2.WithParts>(yield* Scope.Scope, {
      onInterrupt: Effect.die("test runtime cancelled"),
    })
    const workers = yield* Workers.make({
      inspect: () => Effect.succeed(observe(runner)),
      requestCancel: (_, id) => runner.requestCancel(id),
    })
    const calls: Prompt[] = []
    const leases: string[] = []
    const voice = yield* make({
      storage,
      database,
      sessions: {
        get: (id: SessionID) =>
          Effect.gen(function* () {
            const row = yield* database.db
              .select()
              .from(SessionTable)
              .where(eq(SessionTable.id, id))
              .get()
              .pipe(Effect.orDie)
            if (!row) return yield* Effect.fail(new NotFoundError({ message: "Test parent missing" }))
            return { id: SessionID.make(row.id), directory: row.directory }
          }),
      },
      workers,
      admissions: (_, id) =>
        Effect.sync(() => {
          leases.push(id)
          return { amount, dispatch: Effect.void, finish: Effect.void, release: Effect.void }
        }),
      ...policy,
      prompts: {
        prompt: (input: Prompt) =>
          runner.ensureRunning(
            Effect.gen(function* () {
              calls.push(input)
              if (!input.messageID || !(yield* workers.bind(input.sessionID, input.messageID)))
                return yield* Effect.die("cancelled before startup")
              return yield* work(input)
            }).pipe(Effect.orDie, Effect.ensuring(workers.release)),
          ),
      },
    })
    const start = {
      parentSessionID: session,
      providerCallID: crypto.randomUUID(),
      requestID: crypto.randomUUID(),
      model,
    }
    yield* voice.reserve({ parentSessionID: start.parentSessionID, requestID: start.requestID, model }, secret, root)
    const binding = yield* voice.start(start, secret, root)
    return { voice, binding, start, calls, leases, database, storage }
  })

const settled = (read: Effect.Effect<typeof OpenAICall.Type, unknown>) =>
  Effect.gen(function* () {
    for (const _ of Array.from({ length: 200 })) {
      const call = yield* read
      if (call.status !== "accepted" && call.status !== "running") return call
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.die("voice receipt did not settle")
  })

function frontend(state: Effect.Success<ReturnType<typeof fixture>>, scope?: Scope.Scope) {
  return RayaVoice.make({
    storage: state.storage,
    openai: state.voice,
    scope,
    sessions: {
      create: () => Effect.die("legacy child must not be created"),
      get: (id) =>
        Effect.gen(function* () {
          const row = yield* state.database.db
            .select()
            .from(SessionTable)
            .where(eq(SessionTable.id, id))
            .get()
            .pipe(Effect.orDie)
          if (!row) return yield* Effect.fail(new NotFoundError({ message: "Test parent missing" }))
          return Session.fromRow(row)
        }),
    },
    prompts: {
      prompt: () => Effect.die("legacy delegation must not run"),
      cancel: () => Effect.die("canonical work must not be cancelled"),
    },
  })
}

it.live("MF Live refuses an insufficient canonical duration before returning provider credentials", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    return yield* Effect.gen(function* () {
      const state = yield* fixture(root, "gpt-live-1", (input) => Effect.succeed(answer(input)), 0.0000001)
      yield* state.voice.close(state.binding.id, state.binding.generation, secret, root)
      const mf = frontend(state)
      const exit = yield* mf
        .start(
          { version: 2, engine: "openai-live", parentSessionID: session, mediaURL: "http://127.0.0.1:1" },
          "q".repeat(43),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit))
        expect(exit.cause.toString()).toContain("Live media provider admission was not confirmed")
      const keys = yield* state.storage.list(["raya_voice"])
      expect(keys).toHaveLength(1)
      const saved = yield* state.storage.read<{
        info: { maximumSeconds?: number }
        live: { phase: string; admission: { maximumSeconds: number }; binding?: unknown }
      }>(keys[0])
      expect(saved.live.phase).toBe("reserved")
      expect(saved.live.admission.maximumSeconds).toBe(0)
      expect(saved.live.binding).toBeUndefined()
      expect(saved.info.maximumSeconds).toBeUndefined()
      expect(state.calls).toHaveLength(0)
    }).pipe(
      Effect.provide([
        Storage.layerFromDir(path.join(root, "mf-storage")),
        Database.layerFromPath(path.join(root, "mf.sqlite")),
      ]),
    )
  }).pipe(Effect.scoped),
)

for (const mode of ["accepted", "unknown", "stopped", "private", "held"] as const) {
  it.live(
    `MF canonical delegation keeps original scope and one ${mode} result attempt`,
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped()
        return yield* Effect.gen(function* () {
          const scope = yield* Scope.Scope
          const gate = yield* Deferred.make<void>()
          const entered = yield* Deferred.make<void>()
          let release: (() => void) | undefined
          const held = new Promise<void>((resolve) => {
            release = resolve
          })
          const bodies: Record<string, unknown>[] = []
          const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
              const body = (await request.json()) as Record<string, unknown>
              bodies.push(body)
              if (mode === "held") {
                await Effect.runPromise(Deferred.succeed(entered, undefined))
                await held
              }
              const id = new URL(request.url).pathname.split("/")[3]
              return Response.json({
                version: 2,
                sessionID: mode === "unknown" ? "foreign_media_owner" : id,
                delegationID: body.delegationID,
                receiptID: body.receiptID,
                accepted: true,
                played: false,
              })
            },
          })
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              server.stop(true)
              release?.()
            }),
          )
          const state = yield* fixture(root, "gpt-live-1", (input) => {
            if (mode === "private") {
              const result = answer(input)
              return Effect.succeed({
                ...result,
                parts: [
                  {
                    id: PartID.ascending(),
                    messageID: result.info.id,
                    sessionID: session,
                    type: "text" as const,
                    text: "Completed original_task_id for caption_user",
                  },
                ],
              })
            }
            return mode === "stopped"
              ? Deferred.await(gate).pipe(Effect.map(() => answer(input)))
              : Effect.succeed(answer(input))
          })
          yield* state.voice.close(state.binding.id, state.binding.generation, secret, root)
          const mf = frontend(state, scope)
          const info = yield* mf.start(
            {
              version: 2,
              engine: "openai-live",
              parentSessionID: session,
              mediaURL: `http://127.0.0.1:${server.port}`,
            },
            "q".repeat(43),
          )
          const provider = "provider_route_fixture"
          const envelope = (
            seq: number,
            type: string,
            data: Record<string, unknown>,
            item?: string,
            text?: string,
          ) => ({
            session: info.id,
            seq,
            event: {
              seq,
              type,
              session: provider,
              at: new Date().toISOString(),
              data,
              ...(item ? { item } : {}),
              ...(text !== undefined ? { text } : {}),
            },
          })
          expect(yield* mf.event(envelope(1, "session.started", { model: "gpt-live-1" }), info.controlToken)).toBe(true)
          const caption = (seq: number, id: string, text: string, client?: string) =>
            envelope(
              seq,
              "transcript.input.delta",
              {
                type: "session.input_transcript.delta",
                event_id: id,
                delta: text,
                start_ms: seq * 10,
                end_ms: seq * 10 + 5,
                completeTurn: false,
                ...(client ? { client_event_id: client } : {}),
              },
              id,
              text,
            )
          expect(
            yield* mf.event(caption(2, "caption_client", "Context only", "client_result"), info.controlToken),
          ).toBe(true)
          const delegation = (seq: number, id: string) =>
            envelope(
              seq,
              "session.delegation.created",
              { event_id: `event_${id}`, offset_ms: 100, delegation: { id, type: "delegation", target: "client" } },
              id,
            )
          expect(yield* mf.event(delegation(3, "client_only"), info.controlToken)).toBe(false)
          expect(state.calls).toHaveLength(0)
          expect(yield* mf.event(caption(4, "caption_user", "Please summarize the file"), info.controlToken)).toBe(true)
          const wrong = caption(5, "caption_next", "Read-only please")
          expect(
            yield* mf.event({ ...wrong, event: { ...wrong.event, session: "foreign_provider" } }, info.controlToken),
          ).toBe(false)
          expect(yield* mf.event(wrong, info.controlToken)).toBe(true)
          const request = delegation(6, "original_task_id")
          expect(yield* mf.event(request, info.controlToken)).toBe(true)
          expect(yield* mf.event(request, info.controlToken)).toBe(true)
          expect(
            yield* mf.event(
              {
                ...request,
                seq: 7,
                event: {
                  ...request.event,
                  seq: 7,
                  data: mode === "held" ? request.event.data : { ...request.event.data, offset_ms: 101 },
                },
              },
              info.controlToken,
            ),
          ).toBe(mode === "held")
          if (mode === "stopped") {
            yield* mf.close(info.id)
            yield* Deferred.succeed(gate, undefined)
          }
          if (mode === "held") {
            yield* Deferred.await(entered)
            expect(
              yield* mf
                .event(caption(8, "caption_while_result_pending", "One more detail"), info.controlToken)
                .pipe(Effect.timeout("150 millis")),
            ).toBe(true)
            expect(yield* mf.close(info.id).pipe(Effect.timeout("150 millis"))).toBe(true)
            expect(bodies).toHaveLength(1)
            release?.()
          }
          const read = () =>
            state.storage.read<{
              live: {
                secret: string
                binding: { id: string; generation: string }
                tasks: Record<
                  string,
                  {
                    id: string
                    phase: string
                    call?: typeof OpenAICall.Type
                    offer?: { content: string }
                    ack?: { played: boolean }
                  }
                >
              }
            }>(["raya_voice", info.id])
          for (const _ of Array.from({ length: 200 })) {
            const saved = yield* read()
            const task = Object.values(saved.live.tasks)[0]
            if (mode === "stopped" || mode === "held") {
              if (task.call) {
                const call = yield* state.voice.get(
                  saved.live.binding.id,
                  task.call.callID,
                  saved.live.binding.generation,
                  saved.live.secret,
                  root,
                )
                if (call.status === "completed") break
              }
            } else if (task.phase === (mode === "private" ? "accepted" : mode)) break
            yield* Effect.sleep("10 millis")
          }
          const saved = yield* read()
          const task = Object.values(saved.live.tasks)[0]
          expect(task.id).toBe("original_task_id")
          expect(task.call?.parentSessionID).toBe(session)
          expect(state.calls).toHaveLength(1)
          expect(state.calls[0].sessionID).toBe(session)
          const part = state.calls[0].parts[0]
          if (part.type !== "text") throw new Error("Expected canonical task prompt")
          expect(part.text).toContain("imperfect transcript evidence")
          expect(part.text).toContain("Please summarize the file")
          if (mode === "stopped" || mode === "held") {
            expect(bodies).toHaveLength(mode === "held" ? 1 : 0)
            expect(
              (yield* state.voice.get(
                saved.live.binding.id,
                task.call!.callID,
                saved.live.binding.generation,
                saved.live.secret,
                root,
              )).status,
            ).toBe("completed")
          } else {
            expect(task.phase).toBe(mode === "private" ? "accepted" : mode)
            expect(bodies).toHaveLength(1)
            expect(bodies[0].delegationID).toBe("original_task_id")
            expect(Buffer.byteLength(String(bodies[0].content), "utf8")).toBeLessThanOrEqual(500)
            expect(bodies[0].content).toBe(
              mode === "private" ? "The task completed. Details are available in chat." : "Verified Live result",
            )
            if (mode === "accepted" || mode === "private") expect(task.ack?.played).toBe(false)
            yield* frontend(state, scope).event(
              { ...request, seq: 8, event: { ...request.event, seq: 8 } },
              info.controlToken,
            )
            yield* Effect.sleep("120 millis")
            expect(bodies).toHaveLength(1)
          }
          yield* mf.close(info.id)
        }).pipe(
          Effect.provide([
            Storage.layerFromDir(path.join(root, "mf-storage")),
            Database.layerFromPath(path.join(root, "mf.sqlite")),
          ]),
        )
      }).pipe(Effect.scoped),
    30_000,
  )
}

it.live("MF restored unknown ledger versions refuse captions and never resume task delivery", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    return yield* Effect.gen(function* () {
      const state = yield* fixture(root)
      yield* state.voice.close(state.binding.id, state.binding.generation, secret, root)
      const scope = yield* Scope.Scope
      const mf = frontend(state, scope)
      const info = yield* mf.start(
        { version: 2, engine: "openai-live", parentSessionID: session, mediaURL: "http://127.0.0.1:1" },
        "q".repeat(43),
      )
      expect(
        yield* mf.event(
          {
            session: info.id,
            seq: 1,
            event: {
              seq: 1,
              type: "session.started",
              session: "provider_restore_fixture",
              at: new Date().toISOString(),
              data: { model: "gpt-live-1" },
            },
          },
          info.controlToken,
        ),
      ).toBe(true)
      const caption = (seq: number) => ({
        session: info.id,
        seq,
        event: {
          seq,
          type: "transcript.input.delta",
          session: "provider_restore_fixture",
          item: `caption_${seq}`,
          text: "Read the current file",
          at: new Date().toISOString(),
          data: {
            type: "session.input_transcript.delta",
            event_id: `caption_${seq}`,
            delta: "Read the current file",
            start_ms: seq * 10,
            end_ms: seq * 10 + 5,
            completeTurn: false,
          },
        },
      })
      expect(yield* frontend(state, scope).event(caption(2), info.controlToken)).toBe(true)
      const stored = yield* state.storage.read<{ live: { version: number; captions: { version: number } } }>([
        "raya_voice",
        info.id,
      ])
      yield* state.storage.write(["raya_voice", info.id], {
        ...stored,
        live: { ...stored.live, captions: { ...stored.live.captions, version: 99 } },
      })
      expect(yield* frontend(state, scope).event(caption(3), info.controlToken)).toBe(false)
      yield* state.storage.write(["raya_voice", info.id], { ...stored, live: { ...stored.live, version: 99 } })
      expect(yield* frontend(state, scope).event(caption(3), info.controlToken)).toBe(false)
      expect(state.calls).toHaveLength(0)
      yield* mf.close(info.id)
    }).pipe(
      Effect.provide([
        Storage.layerFromDir(path.join(root, "mf-storage")),
        Database.layerFromPath(path.join(root, "mf.sqlite")),
      ]),
    )
  }).pipe(Effect.scoped),
)

it.live("MF setup settlement meters once after a real verified goal completes without renewing authority", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    return yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const database = yield* Database.Service
      let rows: MessageV2.WithParts[] = []
      const sessions = {
        messages: () => Effect.succeed(rows),
        children: () => Effect.succeed([]),
        get: (id: SessionID) =>
          Effect.gen(function* () {
            const row = yield* database.db
              .select()
              .from(SessionTable)
              .where(eq(SessionTable.id, id))
              .get()
              .pipe(Effect.orDie)
            if (!row) return yield* Effect.fail(new NotFoundError({ message: "Test parent missing" }))
            return Session.fromRow(row)
          }),
      }
      const goals = RayaGoal.make({ storage, sessions })
      const charges = yield* GoalCharges.make({ storage, sessions })
      const scope = yield* Scope.Scope
      const error = (err: Error) => new VoiceError({ code: "conflict", message: err.message })
      const state = yield* fixture(root, "gpt-live-1", (input) => Effect.succeed(answer(input)), 1, {
        admissions: (id, token) =>
          charges.claim(id, "USD", token).pipe(
            Effect.map((lease) => ({
              amount: lease.amount,
              dispatch: lease.dispatch.pipe(Effect.mapError(error)),
              finish: lease.finish.pipe(Effect.mapError(error)),
              release: lease.release.pipe(Effect.orDie),
            })),
            Effect.mapError(error),
            Effect.provideService(Scope.Scope, scope),
          ),
        completions: (id, token) => charges.complete(id, "USD", token).pipe(Effect.mapError(error)),
        charges: (input) => {
          const price = pricing({ id: input.id, model: "gpt-live-1", seconds: input.seconds })
          return goals
            .charged(input.sessionID, {
              id: input.id,
              kind: "gpt-live",
              provider: "OpenAI",
              service: "GPT-Live 1",
              source: price.source,
              origin: { sessionID: input.sessionID, callID: input.callID },
              at: input.at,
              quantity: price.quantity,
              unit: price.unit,
              coverage: "recorded",
              amount: price.amount,
              currency: price.currency,
            })
            .pipe(Effect.asVoid, Effect.mapError(error))
        },
      })
      yield* state.voice.close(state.binding.id, state.binding.generation, secret, root)
      yield* goals.create(session, "Verify the command and finish", undefined, undefined, undefined, undefined, {
        chargeCosts: [{ currency: "USD", limit: 2, reservation: 1 }],
      })
      const mf = frontend(state)
      const info = yield* mf.start(
        { version: 2, engine: "openai-live", parentSessionID: session, mediaURL: "http://127.0.0.1:1" },
        "q".repeat(43),
      )
      const user = MessageID.ascending()
      const result = answer({ sessionID: session, messageID: user, parts: [] })
      const part: MessageV2.ToolPart = {
        id: PartID.ascending(),
        messageID: result.info.id,
        sessionID: session,
        type: "tool",
        callID: crypto.randomUUID(),
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "test fixture" },
          output: "all checks passed",
          title: "verification",
          metadata: { exit: 0 },
          time: { start: Date.now(), end: Date.now() },
        },
      }
      rows = [
        {
          info: {
            id: user,
            sessionID: session,
            role: "user",
            time: { created: Date.now() },
            agent: "code",
            model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
          },
          parts: [],
        },
        { ...result, parts: [part] },
      ]
      const completed = yield* goals.update(session, {
        status: "complete",
        summary: "The required command passed.",
        audit: {
          requirements: [
            {
              requirement: "The test command passes",
              passed: true,
              evidence: [{ callID: part.callID, summary: "The recorded completed bash tool exited with code 0." }],
            },
          ],
        },
      })
      expect(completed.status).toBe("complete")
      expect(completed.audit?.requirements[0].passed).toBe(true)
      expect(yield* mf.close(info.id)).toBe(true)
      const event = {
        session: info.id,
        seq: 1,
        event: {
          seq: 1,
          type: "session.setup.closed",
          session: "provider_completed_goal",
          at: new Date().toISOString(),
          data: {
            version: 1,
            started: { event_id: "started_completed_goal", model: "gpt-live-1" },
            final: {
              event_id: "final_completed_goal",
              model: "gpt-live-1",
              reason: "close_requested",
              usage: { seconds: 0.5 },
            },
          },
        },
      }
      expect(yield* mf.event(event, info.controlToken)).toBe(true)
      expect(yield* mf.event(event, info.controlToken)).toBe(true)
      expect(yield* frontend(state).event(event, info.controlToken)).toBe(true)
      expect(yield* mf.event({ ...event, seq: 2, event: { ...event.event, seq: 2 } }, info.controlToken)).toBe(true)
      const saved = yield* goals.get(session)
      expect(saved?.status).toBe("complete")
      expect(saved?.createdAt).toBe(completed.createdAt)
      expect(saved?.charges).toHaveLength(1)
      expect(saved?.charges?.[0]).toMatchObject({ coverage: "recorded", quantity: 0.5, currency: "USD" })
      const binding = yield* storage.read<{
        live: { secret: string; binding: { id: string; generation: string; status: string } }
      }>(["raya_voice", info.id])
      expect(binding.live.binding.status).toBe("closed")
      expect(
        Exit.isFailure(
          yield* state.voice
            .delegate(
              binding.live.binding.id,
              context(binding.live.binding.generation, "forbidden_completed_goal", 1),
              binding.live.secret,
              root,
            )
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(state.calls).toHaveLength(0)
      expect((yield* goals.get(session))?.status).toBe("complete")
    }).pipe(
      Effect.provide([
        Storage.layerFromDir(path.join(root, "mf-storage")),
        Database.layerFromPath(path.join(root, "mf.sqlite")),
      ]),
    )
  }).pipe(Effect.scoped),
)

it.live("MF setup receipts settle after Stop without activating work and preserve unknown final usage", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    return yield* Effect.gen(function* () {
      const state = yield* fixture(root)
      yield* state.voice.close(state.binding.id, state.binding.generation, secret, root)
      const mf = frontend(state)
      const info = yield* mf.start(
        { version: 2, engine: "openai-live", parentSessionID: session, mediaURL: "http://127.0.0.1:1" },
        "q".repeat(43),
      )
      expect(yield* mf.close(info.id)).toBe(true)
      expect(state.leases).toHaveLength(2)
      const event = {
        session: info.id,
        seq: 1,
        event: {
          seq: 1,
          type: "session.setup.closed",
          session: "provider_setup_fixture",
          at: new Date().toISOString(),
          data: { version: 1, started: { event_id: "started_setup_fixture", model: "gpt-live-1" } },
        },
      }
      expect(yield* mf.event(event, "wrong")).toBe(false)
      expect(yield* mf.event(event, info.controlToken)).toBe(true)
      expect(yield* mf.event(event, info.controlToken)).toBe(true)
      const saved = yield* state.storage.read<{
        live: { binding: { id: string; generation: string; status: string }; usage?: unknown }
      }>(["raya_voice", info.id])
      expect(saved.live.binding.status).toBe("closed")
      expect(saved.live.usage).toBeUndefined()
      expect((yield* mf.get(info.id))?.info.status).toBe("closed")
      expect(
        yield* mf.event(
          { ...event, seq: 2, event: { ...event.event, seq: 2, session: "foreign_provider" } },
          info.controlToken,
        ),
      ).toBe(false)
      const final = {
        ...event,
        seq: 3,
        event: {
          ...event.event,
          seq: 3,
          data: {
            ...event.event.data,
            final: {
              event_id: "final_setup_fixture",
              model: "gpt-live-1",
              reason: "close_requested",
              usage: { seconds: 0.5 },
            },
          },
        },
      }
      expect(yield* mf.event(final, info.controlToken)).toBe(true)
      expect(yield* mf.event(final, info.controlToken)).toBe(true)
      expect(yield* frontend(state).event(final, info.controlToken)).toBe(true)
      const recorded = yield* state.storage.read<{ live: { usage: { seconds: number } } }>(["raya_voice", info.id])
      expect(recorded.live.usage.seconds).toBe(0.5)
      expect(
        yield* mf.event(
          { ...final, seq: 4, event: { ...final.event, seq: 4, data: event.event.data } },
          info.controlToken,
        ),
      ).toBe(false)
      expect(
        yield* mf.event(
          { ...final, seq: 4, event: { ...final.event, seq: 4, data: { ...final.event.data, surprise: true } } },
          info.controlToken,
        ),
      ).toBe(false)
      expect(state.calls).toHaveLength(0)
      expect(state.leases).toHaveLength(2)
      const stored = yield* state.storage.read<{ live: { secret: string } }>(["raya_voice", info.id])
      expect(
        Exit.isFailure(
          yield* state.voice
            .delegate(
              saved.live.binding.id,
              context(saved.live.binding.generation, "forbidden_setup_work", 1),
              stored.live.secret,
              root,
            )
            .pipe(Effect.exit),
        ),
      ).toBe(true)
    }).pipe(
      Effect.provide([
        Storage.layerFromDir(path.join(root, "mf-storage")),
        Database.layerFromPath(path.join(root, "mf.sqlite")),
      ]),
    )
  }).pipe(Effect.scoped),
)

it.live("MF Live binds canonical provider identity and meters exact final usage without admitting legacy work", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    return yield* Effect.gen(function* () {
      const state = yield* fixture(root)
      yield* state.voice.close(state.binding.id, state.binding.generation, secret, root)
      const mf = frontend(state)
      const info = yield* mf.start(
        { version: 2, engine: "openai-live", parentSessionID: session, mediaURL: "http://127.0.0.1:1" },
        "q".repeat(43),
      )
      const id = info.id
      const cap = info.controlToken
      const admitted = yield* state.storage.read<{
        live: { phase: string; admission: { requestID: string; status: string; maximumSeconds: number } }
      }>(["raya_voice", id])
      expect(admitted.live.phase).toBe("reserved")
      expect(admitted.live.admission.requestID).toBe(id)
      expect(admitted.live.admission.status).toBe("reserved")
      expect(info.maximumSeconds).toBe(admitted.live.admission.maximumSeconds)
      expect(info.maximumSeconds).toBeGreaterThan(1.4)
      expect(info.maximumSeconds).toBeLessThanOrEqual(86_400)
      const started = {
        session: id,
        seq: 1,
        event: {
          seq: 1,
          type: "session.started",
          session: "provider_mf_fixture",
          at: new Date().toISOString(),
          data: { model: "gpt-live-1" },
        },
      }
      expect(yield* mf.event(started, "wrong")).toBe(false)
      expect(yield* mf.event(started, cap)).toBe(true)
      expect(yield* mf.event(started, cap)).toBe(true)
      const saved = yield* state.storage.read<{
        live: { secret: string; binding: { id: string; generation: string; providerCallID: string } }
      }>(["raya_voice", id])
      expect(saved.live.binding.providerCallID).toBe("provider_mf_fixture")
      const exposed = yield* mf.get(id)
      expect(JSON.stringify(exposed)).not.toContain(saved.live.secret)
      expect(
        yield* mf.event(
          {
            session: id,
            seq: 2,
            event: {
              seq: 2,
              type: "session.usage.updated",
              session: "provider_mf_fixture",
              at: new Date().toISOString(),
              data: { event_id: "running_fixture", usage: { seconds: 0.75 } },
            },
          },
          cap,
        ),
      ).toBe(true)
      const observed = yield* state.storage.read<{ live: { running?: { seconds: number }; usage?: unknown } }>([
        "raya_voice",
        id,
      ])
      expect(observed.live.running?.seconds).toBe(0.75)
      expect(observed.live.usage).toBeUndefined()
      expect(
        yield* mf.event(
          { session: id, seq: 3, event: { seq: 3, type: "session.delegation.created", at: new Date().toISOString() } },
          cap,
        ),
      ).toBe(false)
      expect(state.calls).toHaveLength(0)
      expect(yield* mf.close(id)).toBe(true)
      const closed = {
        session: id,
        seq: 5,
        event: {
          seq: 5,
          type: "session.closed",
          session: "provider_mf_fixture",
          at: new Date().toISOString(),
          data: {
            event_id: "provider_final_fixture",
            model: "gpt-live-1",
            reason: "close_requested",
            usage: { seconds: 1.25 },
          },
        },
      }
      expect(yield* mf.event({ ...closed, event: { ...closed.event, session: "another-provider" } }, cap)).toBe(false)
      expect(yield* mf.event(closed, cap)).toBe(true)
      expect(yield* mf.event(closed, cap)).toBe(true)
      expect(
        yield* state.voice.duration(
          saved.live.binding.id,
          {
            generation: saved.live.binding.generation,
            receipt: { id: "provider_final_fixture", model: "gpt-live-1", seconds: 1.25 },
          },
          saved.live.secret,
          root,
        ),
      ).toEqual({ id: "provider_final_fixture", model: "gpt-live-1", seconds: 1.25 })
      expect(
        yield* mf.event(
          { ...closed, event: { ...closed.event, data: { ...closed.event.data, usage: { seconds: 99 } } } },
          cap,
        ),
      ).toBe(false)
    }).pipe(
      Effect.provide([
        Storage.layerFromDir(path.join(root, "mf-storage")),
        Database.layerFromPath(path.join(root, "mf.sqlite")),
      ]),
    )
  }).pipe(Effect.scoped),
)

function context(generation: string, key: string, sequence: number, text = "Please summarize the current file") {
  return {
    generation,
    context: {
      version: 1 as const,
      delegation: key,
      offset: sequence * 900,
      fragments: [
        {
          id: `frag_${sequence}`,
          speaker: "user" as const,
          text,
          start: 0,
          end: 900,
          sequence,
        },
      ],
      incomplete: true as const,
      omitted: false,
    },
  }
}

it.live(
  "Live duration is immutable, saved after close, and does not reopen work",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const state = yield* fixture(root)
        const receipt = { id: "evt_duration_1", model: "gpt-live-1" as const, seconds: 4 }
        const input = { generation: state.binding.generation, receipt }
        yield* state.voice.close(state.binding.id, state.binding.generation, secret, root)
        expect(yield* state.voice.duration(state.binding.id, input, secret, root)).toEqual(receipt)
        expect(yield* state.voice.duration(state.binding.id, input, secret, root)).toEqual(receipt)
        expect(
          Exit.isFailure(
            yield* state.voice
              .duration(state.binding.id, { ...input, receipt: { ...receipt, seconds: 9 } }, secret, root)
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(state.calls).toEqual([])
        const stored = yield* Store.make(state.database, state.storage).read(state.binding.id)
        expect(stored.duration).toEqual(receipt)
        expect(stored.binding.status).toBe("closed")
        expect(JSON.stringify(stored)).not.toContain(secret)
      }).pipe(
        Effect.provide([
          Storage.layerFromDir(path.join(root, "storage")),
          Database.layerFromPath(path.join(root, "voice.sqlite")),
        ]),
      )
    }),
  30_000,
)

it.live(
  "Live duration refuses a Realtime binding and a Live binding with the wrong generation",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const realtime = yield* fixture(root, "gpt-realtime-2.1")
        const live = yield* fixture(root)
        const receipt = { id: "evt_duration_1", model: "gpt-live-1" as const, seconds: 4 }
        expect(
          Exit.isFailure(
            yield* realtime.voice
              .duration(realtime.binding.id, { generation: realtime.binding.generation, receipt }, secret, root)
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* live.voice
              .duration(live.binding.id, { generation: "stale_generation_1", receipt }, secret, root)
              .pipe(Effect.exit),
          ),
        ).toBe(true)
      }).pipe(
        Effect.provide([
          Storage.layerFromDir(path.join(root, "storage")),
          Database.layerFromPath(path.join(root, "voice.sqlite")),
        ]),
      )
    }),
  30_000,
)

it.live(
  "Live delegation admits once, refuses consumed user sequence, and keeps original context",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const state = yield* fixture(root)
        const first = context(state.binding.generation, "dlg_1", 1)
        const call = yield* state.voice.delegate(state.binding.id, first, secret, root)
        expect(call.callID).toBe(`liv_${createHash("sha256").update("dlg_1").digest("hex").slice(0, 48)}`)
        expect(call.parentSessionID).toBe(session)
        const done = yield* settled(
          state.voice.get(state.binding.id, call.callID, state.binding.generation, secret, root),
        )
        expect(done.status).toBe("completed")
        expect(done.result?.text).toBe("Verified Live result")
        expect(state.calls).toHaveLength(1)
        const part = state.calls[0].parts[0]
        if (part.type !== "text") throw new Error("expected text prompt")
        expect(part.text).toContain("imperfect transcript evidence")
        expect((yield* state.voice.delegate(state.binding.id, first, secret, root)).id).toBe(call.id)
        expect(state.calls).toHaveLength(1)
        expect(
          Exit.isFailure(
            yield* state.voice
              .delegate(state.binding.id, context(state.binding.generation, "dlg_2", 1), secret, root)
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        const next = yield* state.voice.delegate(
          state.binding.id,
          context(state.binding.generation, "dlg_2", 2, "Follow up on the summary"),
          secret,
          root,
        )
        expect(next.callID).not.toBe(call.callID)
        const later = yield* settled(
          state.voice.get(state.binding.id, next.callID, state.binding.generation, secret, root),
        )
        expect(later.status).toBe("completed")
        expect(state.calls).toHaveLength(2)
        const stored = yield* Store.make(state.database, state.storage).read(state.binding.id)
        expect(stored.liveCursor).toBe(2)
        expect(stored.binding.model).toBe("gpt-live-1")
      }).pipe(
        Effect.provide([
          Storage.layerFromDir(path.join(root, "storage")),
          Database.layerFromPath(path.join(root, "voice.sqlite")),
        ]),
      )
    }),
  30_000,
)

it.live(
  "closing Live admission keeps duration writable and refuses new delegation",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const state = yield* fixture(root)
        yield* state.voice.close(state.binding.id, state.binding.generation, secret, root)
        expect(
          Exit.isFailure(
            yield* state.voice
              .delegate(state.binding.id, context(state.binding.generation, "dlg_1", 1), secret, root)
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(state.calls).toEqual([])
        const receipt = { id: "evt_duration_2", model: "gpt-live-1" as const, seconds: 1 }
        expect(
          yield* state.voice.duration(
            state.binding.id,
            { generation: state.binding.generation, receipt },
            secret,
            root,
          ),
        ).toEqual(receipt)
      }).pipe(
        Effect.provide([
          Storage.layerFromDir(path.join(root, "storage")),
          Database.layerFromPath(path.join(root, "voice.sqlite")),
        ]),
      )
    }),
  30_000,
)
