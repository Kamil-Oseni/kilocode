import { expect } from "bun:test"
import path from "node:path"
import { createHash } from "node:crypto"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Git } from "@/git"
import { eq, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { RayaVoiceBindingTable as Table } from "@opencode-ai/core/kilocode/voice.sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { NotFoundError } from "@/storage/storage"
import * as Store from "@/kilocode/voice/openai-store"
import * as Spoken from "@/kilocode/voice/openai-spoken"
import * as Obligations from "@/kilocode/voice/openai-obligations"
import { Storage } from "@/storage/storage"
import { Runner } from "@/effect/runner"
import { observe } from "@/kilocode/effect/observation"
import * as Workers from "@/kilocode/session/task-worker"
import { make, VoiceError } from "@/kilocode/voice/openai"
import type { OpenAIPricing } from "@/kilocode/voice/openai-usage"
import type { OpenAICall, OpenAICallInput } from "@/kilocode/voice/openai-protocol"
import type { SessionPrompt } from "@/session/prompt"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { OpenAITranscript } from "../../../kilo-vscode/src/speech/openai-transcript"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))
const secret = "a".repeat(64)
const session = SessionID.make("ses_openai_voice_test")

const warming = (state: Effect.Success<ReturnType<typeof fixture>>, root: string) =>
  Effect.gen(function* () {
    const target = "b".repeat(64)
    const input = {
      version: 1 as const,
      generation: state.binding.generation,
      requestID: "handoff-one",
      providerCallID: "replacement-one",
      reservationID: "replacement-budget",
    }
    yield* state.voice.reserve(
      { parentSessionID: session, requestID: input.reservationID, model: state.binding.model },
      target,
      root,
    )
    const binding = yield* state.voice.candidate(state.binding.id, input, secret, target, root)
    const context = yield* state.voice.handoffContext(binding.id, binding.generation, target, root)
    const ready = {
      version: 1 as const,
      generation: binding.generation,
      readyID: "prefill-one",
      sourceRevision: context.sourceRevision,
      sourceHash: context.sourceHash,
    }
    const activate = {
      ...ready,
      generation: state.binding.generation,
      requestID: input.requestID,
      candidateID: binding.id,
      candidateGeneration: binding.generation,
    }
    return { target, input, binding, context, ready, activate }
  })

it.live(
  "retained activation keeps the original running job across source closure and late target delivery",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const state = yield* fixture(root, (input) =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(answer(input))),
        )
        const call = yield* state.voice.submit(state.binding.id, state.input, secret, root)
        yield* Deferred.await(entered)
        const next = yield* warming(state, root)
        yield* state.voice.ready(next.binding.id, next.ready, next.target, root)
        expect(
          yield* state.voice.activate(state.binding.id, next.activate, secret, root).pipe(Effect.flip),
        ).toMatchObject({ code: "conflict" })
        const manifest = yield* state.voice.manifest(next.binding.id, next.binding.generation, next.target, root)
        expect(manifest.references).toHaveLength(1)
        expect(manifest.references[0]!.createdAt).toBe(call.createdAt)
        const input = { ...next.activate, manifestID: manifest.manifestID, manifestHash: manifest.hash }
        const receipt = yield* state.voice.activateRetained(state.binding.id, input, secret, root)
        expect(yield* state.voice.activateRetained(state.binding.id, input, secret, root)).toEqual(receipt)
        yield* state.voice.close(state.binding.id, state.binding.generation, secret, root)
        const ref = manifest.references[0]!
        expect(
          (yield* state.voice.obligations(state.binding.id, state.binding.generation, secret, root)).references,
        ).toEqual([ref])
        expect(
          (yield* state.voice.obligations(next.binding.id, next.binding.generation, next.target, root)).references,
        ).toEqual([ref])
        const before = yield* state.voice.obligation(
          next.binding.id,
          ref.id,
          next.binding.generation,
          next.target,
          root,
        )
        expect(before.receipt.status).toBe("running")
        yield* Deferred.succeed(release, undefined)
        const final = yield* settled(
          state.voice.get(state.binding.id, state.input.callID, state.binding.generation, secret, root),
        )
        const result = yield* state.voice.obligation(
          next.binding.id,
          ref.id,
          next.binding.generation,
          next.target,
          root,
        )
        expect(result.receipt).toEqual(final)
        expect(result.receipt.status).toBe("completed")
        expect(state.calls).toHaveLength(1)
        const offer = {
          version: 1 as const,
          action: "offer" as const,
          generation: next.binding.generation,
          offerID: "retained-offer",
          providerCallID: next.binding.providerCallID,
          itemID: "semantic-result",
          resultHash: result.resultHash!,
          deliveryEpoch: 1,
        }
        expect(Obligations.validInput({ ...offer, constructor: "unexpected" })).toBe(false)
        expect(
          yield* state.voice
            .delivery(next.binding.id, ref.id, { ...offer, providerCallID: "forged-provider" }, next.target, root)
            .pipe(Effect.flip),
        ).toMatchObject({ code: "conflict" })
        const offered = yield* state.voice.delivery(next.binding.id, ref.id, offer, next.target, root)
        expect(yield* state.voice.delivery(next.binding.id, ref.id, offer, next.target, root)).toEqual(offered)
        const accepted = {
          ...offer,
          action: "ack" as const,
          ackID: "accepted-result",
          phase: "accepted" as const,
          eventID: "provider-created",
        }
        expect(
          yield* state.voice
            .delivery(
              next.binding.id,
              ref.id,
              { ...accepted, ackID: "premature-playback", phase: "played", eventID: "premature-stopped" },
              next.target,
              root,
            )
            .pipe(Effect.flip),
        ).toMatchObject({ code: "conflict" })
        const ack = yield* state.voice.delivery(next.binding.id, ref.id, accepted, next.target, root)
        expect(
          yield* state.voice
            .delivery(
              next.binding.id,
              ref.id,
              { ...accepted, ackID: "accepted-playback", phase: "played", eventID: "accepted-stopped" },
              next.target,
              root,
            )
            .pipe(Effect.flip),
        ).toMatchObject({ code: "conflict" })
        expect(
          yield* state.voice
            .delivery(
              next.binding.id,
              ref.id,
              { ...accepted, ackID: "missing-response", phase: "generated", eventID: "generated-event" },
              next.target,
              root,
            )
            .pipe(Effect.flip),
        ).toMatchObject({ code: "conflict" })
        const generated = {
          ...accepted,
          ackID: "generated-result",
          phase: "generated" as const,
          eventID: "provider-generated",
          responseID: "target-narration",
        }
        const generation = yield* state.voice.delivery(next.binding.id, ref.id, generated, next.target, root)
        expect(
          yield* state.voice
            .delivery(
              next.binding.id,
              ref.id,
              {
                ...generated,
                ackID: "wrong-playback",
                phase: "played",
                eventID: "wrong-stopped",
                responseID: "wrong-response",
              },
              next.target,
              root,
            )
            .pipe(Effect.flip),
        ).toMatchObject({ code: "conflict" })
        yield* state.voice.delivery(
          next.binding.id,
          ref.id,
          { ...generated, ackID: "played-result", phase: "played", eventID: "client-playback-confirmed" },
          next.target,
          root,
        )
        expect(yield* state.voice.delivery(next.binding.id, ref.id, accepted, next.target, root)).toEqual(ack)
        expect(yield* state.voice.delivery(next.binding.id, ref.id, generated, next.target, root)).toEqual(generation)
        expect(
          (yield* state.voice.obligations(next.binding.id, next.binding.generation, next.target, root)).references,
        ).toEqual([])
        expect(
          yield* state.voice
            .delivery(next.binding.id, ref.id, { ...accepted, eventID: "changed" }, next.target, root)
            .pipe(Effect.flip),
        ).toMatchObject({ code: "conflict" })
        const restarted = yield* make(state.deps)
        expect(yield* restarted.transferReceipt(state.binding.id, state.binding.generation, secret, root)).toEqual(
          receipt,
        )
        expect(
          (yield* restarted.obligation(next.binding.id, ref.id, next.binding.generation, next.target, root)).receipt,
        ).toEqual(final)
        expect(
          yield* restarted.delivery(next.binding.id, ref.id, accepted, next.target, root).pipe(Effect.flip),
        ).toMatchObject({ code: "conflict" })
        expect(
          yield* restarted.activateRetained(state.binding.id, input, secret, root).pipe(Effect.flip),
        ).toMatchObject({ code: "conflict" })
        const saved = yield* retained(state.binding.id)
        const prior = saved.deliveries![ref.id]!
        yield* state.deps.database.db
          .update(Table)
          .set({
            data: {
              ...saved,
              deliveries: {
                ...saved.deliveries,
                [ref.id]: { ...prior, phase: "accepted", acks: [...prior.acks].reverse() },
              },
            },
          })
          .where(eq(Table.id, state.binding.id))
          .run()
          .pipe(Effect.orDie)
        expect(
          yield* state.voice
            .obligation(next.binding.id, ref.id, next.binding.generation, next.target, root)
            .pipe(Effect.flip),
        ).toMatchObject({ code: "conflict" })
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
  "retained offered results forward across two handoffs and late original acknowledgements never authorize replay",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const state = yield* fixture(root)
        yield* state.voice.submit(state.binding.id, state.input, secret, root)
        yield* settled(state.voice.get(state.binding.id, state.input.callID, state.binding.generation, secret, root))
        const saved = yield* retained(state.binding.id)
        const ref = Object.values(saved.deliveries!)[0]!.reference
        const result = yield* state.voice.obligation(state.binding.id, ref.id, state.binding.generation, secret, root)
        const offer = {
          version: 1 as const,
          action: "offer" as const,
          generation: state.binding.generation,
          offerID: "source-offer",
          providerCallID: state.binding.providerCallID,
          itemID: "source-semantic",
          resultHash: result.resultHash!,
          deliveryEpoch: 1,
        }
        yield* state.voice.delivery(state.binding.id, ref.id, offer, secret, root)
        const next = yield* warming(state, root)
        yield* state.voice.ready(next.binding.id, next.ready, next.target, root)
        const manifest = yield* state.voice.manifest(next.binding.id, next.binding.generation, next.target, root)
        const input = { ...next.activate, manifestID: manifest.manifestID, manifestHash: manifest.hash }
        const first = yield* state.voice.activateRetained(state.binding.id, input, secret, root)
        const ack = {
          ...offer,
          action: "ack" as const,
          ackID: "late-acceptance",
          phase: "accepted" as const,
          eventID: "original-provider-event",
        }
        const accepted = yield* state.voice.delivery(state.binding.id, ref.id, ack, secret, root)
        expect(
          (yield* state.voice.obligation(next.binding.id, ref.id, next.binding.generation, next.target, root)).delivery
            .phase,
        ).toBe("accepted")
        expect(
          yield* state.voice
            .delivery(
              next.binding.id,
              ref.id,
              { ...offer, generation: next.binding.generation, providerCallID: next.binding.providerCallID },
              next.target,
              root,
            )
            .pipe(Effect.flip),
        ).toMatchObject({ code: "conflict" })
        const key = "c".repeat(64)
        const preparing = {
          version: 1 as const,
          generation: next.binding.generation,
          requestID: "second-transfer",
          providerCallID: "third-provider",
          reservationID: "third-budget",
        }
        yield* state.voice.reserve(
          { parentSessionID: session, requestID: preparing.reservationID, model: next.binding.model },
          key,
          root,
        )
        const third = yield* state.voice.candidate(next.binding.id, preparing, next.target, key, root)
        const context = yield* state.voice.handoffContext(third.id, third.generation, key, root)
        const ready = {
          version: 1 as const,
          generation: third.generation,
          readyID: "third-ready",
          sourceRevision: context.sourceRevision,
          sourceHash: context.sourceHash,
        }
        yield* state.voice.ready(third.id, ready, key, root)
        const onward = yield* state.voice.manifest(third.id, third.generation, key, root)
        expect(onward.references).toEqual([ref])
        yield* state.voice.activateRetained(
          next.binding.id,
          {
            ...ready,
            generation: next.binding.generation,
            requestID: preparing.requestID,
            candidateID: third.id,
            candidateGeneration: third.generation,
            manifestID: onward.manifestID,
            manifestHash: onward.hash,
          },
          next.target,
          root,
        )
        expect(yield* state.voice.activateRetained(state.binding.id, input, secret, root)).toEqual(first)
        expect(yield* state.voice.delivery(state.binding.id, ref.id, ack, secret, root)).toEqual(accepted)
        const generated = {
          ...ack,
          ackID: "late-generation",
          phase: "generated" as const,
          eventID: "original-generated",
          responseID: "original-response",
        }
        yield* state.voice.delivery(state.binding.id, ref.id, generated, secret, root)
        yield* state.voice.delivery(
          state.binding.id,
          ref.id,
          { ...generated, ackID: "late-playback", phase: "played", eventID: "original-client-playback-confirmed" },
          secret,
          root,
        )
        expect((yield* state.voice.obligation(third.id, ref.id, third.generation, key, root)).delivery.phase).toBe(
          "played",
        )
        expect(
          yield* state.voice
            .delivery(
              third.id,
              ref.id,
              { ...offer, generation: third.generation, providerCallID: third.providerCallID },
              key,
              root,
            )
            .pipe(Effect.flip),
        ).toMatchObject({ code: "conflict" })
        expect(state.calls).toHaveLength(1)
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
  "retained target cancellation is exact, old-owner jobs remain unknown and legacy deliveries are never guessed",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const state = yield* fixture(root, () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        )
        const events: string[] = []
        const cancel = state.deps.workers.cancel
        state.deps.workers.cancel = (sid, message) =>
          Effect.sync(() => events.push(message)).pipe(Effect.andThen(cancel(sid, message)))
        const call = yield* state.voice.submit(state.binding.id, state.input, secret, root)
        yield* Deferred.await(entered)
        const next = yield* warming(state, root)
        yield* state.voice.ready(next.binding.id, next.ready, next.target, root)
        const manifest = yield* state.voice.manifest(next.binding.id, next.binding.generation, next.target, root)
        const ref = manifest.references[0]!
        yield* state.voice.activateRetained(
          state.binding.id,
          { ...next.activate, manifestID: manifest.manifestID, manifestHash: manifest.hash },
          secret,
          root,
        )
        expect(
          yield* state.voice
            .cancel(state.binding.id, state.input.callID, state.binding.generation, secret, root)
            .pipe(Effect.flip),
        ).toMatchObject({ code: "conflict" })
        const restarted = yield* make(state.deps)
        expect(
          (yield* restarted.obligation(next.binding.id, ref.id, next.binding.generation, next.target, root)).receipt
            .status,
        ).toBe("unknown")
        expect(
          yield* restarted
            .cancelObligation(next.binding.id, ref.id, next.binding.generation, next.target, root)
            .pipe(Effect.flip),
        ).toMatchObject({ code: "conflict" })
        expect(events).toEqual([])
        const cancelled = yield* state.voice.cancelObligation(
          next.binding.id,
          ref.id,
          next.binding.generation,
          next.target,
          root,
        )
        expect(cancelled.status).toBe("cancelled")
        expect(events).toEqual([call.messageID])
        expect(
          yield* state.voice.cancelObligation(next.binding.id, ref.id, next.binding.generation, next.target, root),
        ).toEqual(cancelled)
        expect(events).toEqual([call.messageID])
        const legacy = yield* retained(state.binding.id)
        yield* Store.make(state.deps.database, state.deps.storage).replace({ ...legacy, deliveries: undefined })
        expect(
          yield* state.voice
            .obligation(next.binding.id, ref.id, next.binding.generation, next.target, root)
            .pipe(Effect.flip),
        ).toMatchObject({ code: "conflict" })
        expect(state.calls).toHaveLength(1)
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
  "retained manifest is stable when work finishes and paired SQLite failure transfers nothing",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const state = yield* fixture(root, (input) =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(answer(input))),
        )
        yield* state.voice.submit(state.binding.id, state.input, secret, root)
        yield* Deferred.await(entered)
        const next = yield* warming(state, root)
        yield* state.voice.ready(next.binding.id, next.ready, next.target, root)
        const manifest = yield* state.voice.manifest(next.binding.id, next.binding.generation, next.target, root)
        yield* Deferred.succeed(release, undefined)
        yield* settled(state.voice.get(state.binding.id, state.input.callID, state.binding.generation, secret, root))
        expect(yield* state.voice.manifest(next.binding.id, next.binding.generation, next.target, root)).toEqual(
          manifest,
        )
        const input = { ...next.activate, manifestID: manifest.manifestID, manifestHash: manifest.hash }
        const source = yield* retained(state.binding.id)
        const target = yield* retained(next.binding.id)
        const db = state.deps.database.db
        yield* db
          .run(
            sql`CREATE TRIGGER refuse_transfer BEFORE UPDATE ON raya_voice_binding WHEN json_extract(OLD.data, '$.binding.handoff.phase') = 'ready' BEGIN SELECT RAISE(ABORT, 'transfer denied'); END`,
          )
          .pipe(Effect.orDie)
        expect(
          Exit.isFailure(yield* state.voice.activateRetained(state.binding.id, input, secret, root).pipe(Effect.exit)),
        ).toBe(true)
        expect(yield* retained(state.binding.id)).toEqual(source)
        expect(yield* retained(next.binding.id)).toEqual(target)
        yield* db.run(sql`DROP TRIGGER refuse_transfer`).pipe(Effect.orDie)
        expect(
          yield* state.voice
            .activateRetained(state.binding.id, { ...input, manifestHash: "0".repeat(64) }, secret, root)
            .pipe(Effect.flip),
        ).toMatchObject({ code: "conflict" })
        yield* state.voice.activateRetained(state.binding.id, input, secret, root)
        expect(state.calls).toHaveLength(1)
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
  "warm readiness rearming is durable CAS with a fixed deadline and real SQLite rollback",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const state = yield* fixture(root)
        const next = yield* warming(state, root)
        const prepared = yield* state.voice.ready(next.binding.id, next.ready, next.target, root)
        yield* state.voice.spoken(
          state.binding.id,
          {
            version: 1,
            generation: state.binding.generation,
            providerCallID: state.binding.providerCallID,
            revision: 1,
            items: [{ id: "delta", previous: null, role: "user", state: "final", text: "A new turn" }],
          },
          secret,
          root,
        )
        const context = yield* state.voice.handoffContext(next.binding.id, next.binding.generation, next.target, root)
        const input = {
          ...next.ready,
          priorReadyID: next.ready.readyID,
          readyID: "prefill-two",
          sourceRevision: context.sourceRevision,
          sourceHash: context.sourceHash,
        }
        const conflict = <A, E>(request: Effect.Effect<A, E>) =>
          request.pipe(
            Effect.flip,
            Effect.map((err) => {
              expect(err).toMatchObject({ _tag: "VoiceError", code: "conflict" })
            }),
          )
        yield* conflict(state.voice.rearm(next.binding.id, { ...input, priorReadyID: "wrong" }, next.target, root))
        yield* conflict(
          state.voice.rearm(next.binding.id, { ...input, sourceHash: next.ready.sourceHash }, next.target, root),
        )
        expect(
          yield* state.voice
            .rearm(next.binding.id, { ...input, readyID: "bad\n" }, next.target, root)
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "VoiceError", code: "invalid" })
        const before = yield* retained(next.binding.id)
        const db = state.deps.database.db
        yield* db
          .run(
            sql`CREATE TRIGGER refuse_rearm BEFORE UPDATE ON raya_voice_binding WHEN json_extract(OLD.data, '$.binding.handoff.phase') = 'ready' BEGIN SELECT RAISE(ABORT, 'rearm denied'); END`,
          )
          .pipe(Effect.orDie)
        expect(
          Exit.isFailure(yield* state.voice.rearm(next.binding.id, input, next.target, root).pipe(Effect.exit)),
        ).toBe(true)
        expect(yield* retained(next.binding.id)).toEqual(before)
        yield* db.run(sql`DROP TRIGGER refuse_rearm`).pipe(Effect.orDie)
        const receipt = yield* state.voice.rearm(next.binding.id, input, next.target, root)
        expect(receipt.deadline).toBe(prepared.handoff!.deadline!)
        expect(yield* state.voice.rearm(next.binding.id, input, next.target, root)).toEqual(receipt)
        yield* conflict(state.voice.rearm(next.binding.id, { ...input, sourceRevision: 2 }, next.target, root))
        yield* conflict(state.voice.activate(state.binding.id, next.activate, secret, root))
        yield* conflict(state.voice.ready(next.binding.id, next.ready, next.target, root))
        const latest = { ...input, priorReadyID: input.readyID, readyID: "prefill-three" }
        const second = yield* state.voice.rearm(next.binding.id, latest, next.target, root)
        expect(second.deadline).toBe(receipt.deadline)
        expect(yield* state.voice.rearm(next.binding.id, input, next.target, root)).toEqual(receipt)
        yield* conflict(
          state.voice.rearm(
            next.binding.id,
            { ...latest, priorReadyID: latest.readyID, readyID: next.ready.readyID },
            next.target,
            root,
          ),
        )
        yield* state.voice.activate(
          state.binding.id,
          {
            ...next.activate,
            readyID: latest.readyID,
            sourceRevision: latest.sourceRevision,
            sourceHash: latest.sourceHash,
          },
          secret,
          root,
        )
        expect(yield* state.voice.rearm(next.binding.id, input, next.target, root)).toEqual(receipt)
        const restarted = yield* make(state.deps)
        yield* conflict(restarted.rearm(next.binding.id, input, next.target, root))
        expect(state.calls).toEqual([])
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
  "warm readiness rearming bounds receipts, refuses expired CAS and fails closed on malformed history",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const state = yield* fixture(root)
        const next = yield* warming(state, root)
        const prepared = yield* state.voice.ready(next.binding.id, next.ready, next.target, root)
        const inputs = Array.from({ length: 17 }, (_, index) => ({
          ...next.ready,
          priorReadyID: index === 0 ? next.ready.readyID : `ack-${index - 1}`,
          readyID: `ack-${index}`,
        }))
        const first = yield* state.voice.rearm(next.binding.id, inputs[0]!, next.target, root)
        for (const input of inputs.slice(1, 16)) {
          const receipt = yield* state.voice.rearm(next.binding.id, input, next.target, root)
          expect(receipt.deadline).toBe(prepared.handoff!.deadline!)
        }
        expect(
          yield* state.voice.rearm(next.binding.id, inputs[16]!, next.target, root).pipe(Effect.flip),
        ).toMatchObject({ _tag: "VoiceError", code: "conflict" })
        const saved = yield* retained(next.binding.id)
        expect(saved.rearms).toHaveLength(16)
        const store = Store.make(state.deps.database, state.deps.storage)
        yield* store.replace({
          ...saved,
          binding: { ...saved.binding, handoff: { ...saved.binding.handoff!, deadline: Date.now() - 1 } },
        })
        expect(yield* state.voice.rearm(next.binding.id, inputs[0]!, next.target, root)).toEqual(first)
        expect(
          yield* state.voice.rearm(next.binding.id, inputs[16]!, next.target, root).pipe(Effect.flip),
        ).toMatchObject({ _tag: "VoiceError", code: "expired" })
        const invalid = { ...saved, rearms: [{ ...first, readyID: "invalid\n" }] }
        yield* state.deps.database.db
          .update(Table)
          .set({ data: invalid })
          .where(eq(Table.id, next.binding.id))
          .run()
          .pipe(Effect.orDie)
        expect(
          yield* state.voice.rearm(next.binding.id, inputs[0]!, next.target, root).pipe(Effect.flip),
        ).toMatchObject({ _tag: "VoiceError", code: "conflict" })
        expect(state.calls).toEqual([])
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
  "warm authority refuses malformed expiry and bounded parent overflow without staging input",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const state = yield* fixture(root)
        const saved = yield* retained(state.binding.id)
        const db = state.deps.database.db
        const invalid = { ...saved, binding: { ...saved.binding, id: "invalid-expiry", expiresAt: "tomorrow" } }
        yield* db
          .insert(Table)
          .values({ id: invalid.binding.id, session_id: session, data: invalid })
          .run()
          .pipe(Effect.orDie)
        const input = { generation: state.binding.generation, id: "safe-image", mime: "image/png" as const, data: png }
        expect(Exit.isFailure(yield* state.voice.stage(state.binding.id, input, secret, root).pipe(Effect.exit))).toBe(
          true,
        )
        expect((yield* retained(state.binding.id)).images).toBeUndefined()
        yield* db.delete(Table).where(eq(Table.id, invalid.binding.id)).run().pipe(Effect.orDie)
        const rows = Array.from({ length: 65 }, (_, index) => {
          const id = `overflow-${index}`
          return { id, session_id: session, data: { ...saved, binding: { ...saved.binding, id } } }
        })
        yield* db.insert(Table).values(rows).run().pipe(Effect.orDie)
        expect(Exit.isFailure(yield* state.voice.stage(state.binding.id, input, secret, root).pipe(Effect.exit))).toBe(
          true,
        )
        expect((yield* retained(state.binding.id)).images).toBeUndefined()
        expect(state.calls).toEqual([])
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
  "warm handoff binds the real host checkpoint, denies candidate work, and resolves exact activation receipts",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const state = yield* fixture(root)
        const collector = new OpenAITranscript(async (snapshot) => {
          await Effect.runPromise(
            state.voice.spoken(
              state.binding.id,
              {
                ...snapshot,
                generation: state.binding.generation,
                providerCallID: state.binding.providerCallID,
              },
              secret,
              root,
            ),
          )
        })
        collector.receive({
          type: "conversation.item.added",
          event_id: "create-one",
          previous_item_id: null,
          item: { id: "user-one", type: "message", role: "user", content: [{ type: "input_audio" }] },
        })
        collector.receive({
          type: "conversation.item.input_audio_transcription.completed",
          event_id: "transcript-one",
          item_id: "user-one",
          content_index: 0,
          transcript: "I want to learn the violin.",
        })
        const checkpoint = yield* Effect.promise(() => collector.checkpoint())
        expect(checkpoint.ready).toBe(true)
        const next = yield* warming(state, root)
        expect(next.context.sourceRevision).toBe(checkpoint.revision)
        expect(next.context.sourceHash).toBe(checkpoint.fingerprint)
        expect(next.context.items).toEqual([{ itemID: "user-one", role: "user", text: "I want to learn the violin." }])
        expect(yield* state.voice.candidate(state.binding.id, next.input, secret, next.target, root)).toEqual(
          next.binding,
        )
        for (const changed of [
          { ...next.input, requestID: "conflict" },
          { ...next.input, requestID: "bad\n" },
          { ...next.input, extra: true },
        ])
          expect(
            Exit.isFailure(
              yield* state.voice.candidate(state.binding.id, changed, secret, next.target, root).pipe(Effect.exit),
            ),
          ).toBe(true)
        expect(
          Exit.isFailure(
            yield* state.voice.candidate(state.binding.id, next.input, secret, secret, root).pipe(Effect.exit),
          ),
        ).toBe(true)
        for (const phase of ["candidate", "ready"]) {
          if (phase === "ready") yield* state.voice.ready(next.binding.id, next.ready, next.target, root)
          expect(
            Exit.isFailure(
              yield* state.voice
                .submit(next.binding.id, { ...state.input, generation: next.binding.generation }, next.target, root)
                .pipe(Effect.exit),
            ),
          ).toBe(true)
          expect(
            Exit.isFailure(
              yield* state.voice
                .stage(
                  next.binding.id,
                  { generation: next.binding.generation, id: "image", mime: "image/png", data: png },
                  next.target,
                  root,
                )
                .pipe(Effect.exit),
            ),
          ).toBe(true)
        }
        const prepared = yield* state.voice.ready(next.binding.id, next.ready, next.target, root)
        expect(yield* state.voice.ready(next.binding.id, next.ready, next.target, root)).toEqual(prepared)
        const receipt = yield* state.voice.activate(state.binding.id, next.activate, secret, root)
        expect(yield* state.voice.activate(state.binding.id, next.activate, secret, root)).toEqual(receipt)
        expect(yield* state.voice.handoffReceipt(state.binding.id, state.binding.generation, secret, root)).toEqual(
          receipt,
        )
        expect((yield* retained(state.binding.id)).binding.handoff?.phase).toBe("retiring")
        expect((yield* retained(next.binding.id)).binding.handoff?.phase).toBe("active")
        const third = "c".repeat(64)
        const input = {
          version: 1 as const,
          generation: next.binding.generation,
          requestID: "handoff-three",
          providerCallID: "provider-three",
          reservationID: "budget-three",
        }
        yield* state.voice.reserve(
          { parentSessionID: session, requestID: input.reservationID, model: next.binding.model },
          third,
          root,
        )
        const binding = yield* state.voice.candidate(next.binding.id, input, next.target, third, root)
        const context = yield* state.voice.handoffContext(binding.id, binding.generation, third, root)
        const ready = {
          version: 1 as const,
          generation: binding.generation,
          readyID: "prefill-three",
          sourceRevision: context.sourceRevision,
          sourceHash: context.sourceHash,
        }
        yield* state.voice.ready(binding.id, ready, third, root)
        yield* state.voice.activate(
          next.binding.id,
          {
            ...ready,
            generation: next.binding.generation,
            requestID: input.requestID,
            candidateID: binding.id,
            candidateGeneration: binding.generation,
          },
          next.target,
          root,
        )
        expect(yield* state.voice.activate(state.binding.id, next.activate, secret, root)).toEqual(receipt)
        const started = Date.now()
        for (const request of [
          state.voice.handoffContext(next.binding.id, next.binding.generation, next.target, root).pipe(Effect.asVoid),
          state.voice.ready(next.binding.id, next.ready, next.target, root).pipe(Effect.asVoid),
        ])
          expect(yield* request.pipe(Effect.flip, Effect.timeout("1 second"))).toMatchObject({
            _tag: "VoiceError",
            code: "conflict",
          })
        expect(Date.now() - started).toBeLessThan(1000)
        expect(
          Exit.isFailure(
            yield* state.voice
              .activate(state.binding.id, { ...next.activate, readyID: "other" }, secret, root)
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* state.voice
              .submit(state.binding.id, { ...state.input, callID: "retired" }, secret, root)
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        const saved = (yield* retained(state.binding.id)).spoken!
        yield* state.voice.spoken(
          state.binding.id,
          {
            version: 1,
            generation: state.binding.generation,
            providerCallID: state.binding.providerCallID,
            revision: saved.revision + 1,
            incomplete: true,
            items: saved.items.map((item) => ({
              id: item.id,
              previous: item.previous,
              role: item.role,
              state: "omitted" as const,
            })),
          },
          secret,
          root,
        )
        expect(
          Exit.isFailure(
            yield* state.voice
              .spoken(
                state.binding.id,
                {
                  version: 1,
                  generation: state.binding.generation,
                  providerCallID: state.binding.providerCallID,
                  revision: saved.revision + 2,
                  incomplete: true,
                  items: [{ id: "new", previous: null, role: "user", state: "final", text: "new work" }],
                },
                secret,
                root,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        yield* state.voice.close(state.binding.id, state.binding.generation, secret, root)
        expect(yield* state.voice.handoffReceipt(state.binding.id, state.binding.generation, secret, root)).toEqual(
          receipt,
        )
        const reopened = yield* make(state.deps)
        expect(yield* reopened.handoffReceipt(state.binding.id, state.binding.generation, secret, root)).toEqual(
          receipt,
        )
        expect(
          Exit.isFailure(yield* reopened.activate(state.binding.id, next.activate, secret, root).pipe(Effect.exit)),
        ).toBe(true)
        expect(
          Exit.isFailure(yield* reopened.ready(next.binding.id, next.ready, next.target, root).pipe(Effect.exit)),
        ).toBe(true)
        expect(state.calls).toEqual([])
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
  "warm handoff transactions roll back both creation and activation under real SQLite failures",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const state = yield* fixture(root)
        yield* state.voice.submit(state.binding.id, state.input, secret, root)
        const call = yield* settled(
          state.voice.get(state.binding.id, state.input.callID, state.binding.generation, secret, root),
        )
        const before = yield* retained(state.binding.id)
        const db = state.deps.database.db
        yield* db
          .run(
            sql`CREATE TRIGGER refuse_candidate BEFORE INSERT ON raya_voice_binding BEGIN SELECT RAISE(ABORT, 'candidate denied'); END`,
          )
          .pipe(Effect.orDie)
        expect(Exit.isFailure(yield* warming(state, root).pipe(Effect.exit))).toBe(true)
        expect(yield* retained(state.binding.id)).toEqual(before)
        expect(yield* db.select().from(Table).pipe(Effect.orDie)).toHaveLength(1)
        yield* db.run(sql`DROP TRIGGER refuse_candidate`).pipe(Effect.orDie)
        const next = yield* warming(state, root)
        yield* state.voice.ready(next.binding.id, next.ready, next.target, root)
        const source = yield* retained(state.binding.id)
        const target = yield* retained(next.binding.id)
        yield* db
          .run(
            sql`CREATE TRIGGER refuse_activation BEFORE UPDATE ON raya_voice_binding WHEN json_extract(OLD.data, '$.binding.handoff.phase') = 'ready' BEGIN SELECT RAISE(ABORT, 'activation denied'); END`,
          )
          .pipe(Effect.orDie)
        expect(
          Exit.isFailure(yield* state.voice.activate(state.binding.id, next.activate, secret, root).pipe(Effect.exit)),
        ).toBe(true)
        expect(yield* retained(state.binding.id)).toEqual(source)
        expect(yield* retained(next.binding.id)).toEqual(target)
        yield* db.run(sql`DROP TRIGGER refuse_activation`).pipe(Effect.orDie)
        yield* state.voice.activate(state.binding.id, next.activate, secret, root)
        expect(yield* state.voice.submit(state.binding.id, state.input, secret, root)).toEqual(call)
        expect(
          Exit.isFailure(
            yield* state.voice
              .submit(state.binding.id, { ...state.input, arguments: { request: "changed" } }, secret, root)
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(state.calls).toHaveLength(1)
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
  "warm handoff refuses changed checkpoints, unfinished work, expired readiness and rival ordinary starts",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const state = yield* fixture(root)
        const next = yield* warming(state, root)
        yield* state.voice.ready(next.binding.id, next.ready, next.target, root)
        const rival = { ...state.start, requestID: "rival-budget", providerCallID: "rival-provider" }
        yield* state.voice.reserve(
          { parentSessionID: session, requestID: rival.requestID, model: state.binding.model },
          secret,
          root,
        )
        expect(Exit.isFailure(yield* state.voice.start(rival, secret, root).pipe(Effect.exit))).toBe(true)
        yield* state.voice.spoken(
          state.binding.id,
          {
            version: 1,
            generation: state.binding.generation,
            providerCallID: state.binding.providerCallID,
            revision: 1,
            items: [{ id: "later", previous: null, role: "user", state: "final", text: "A changed turn." }],
          },
          secret,
          root,
        )
        expect(
          Exit.isFailure(yield* state.voice.activate(state.binding.id, next.activate, secret, root).pipe(Effect.exit)),
        ).toBe(true)
        expect(
          Exit.isFailure(yield* state.voice.ready(next.binding.id, next.ready, next.target, root).pipe(Effect.exit)),
        ).toBe(true)
        yield* state.voice.close(next.binding.id, next.binding.generation, next.target, root)
        const again = {
          ...next.input,
          requestID: "handoff-two",
          reservationID: "budget-two",
          providerCallID: "replacement-two",
        }
        yield* state.voice.reserve(
          { parentSessionID: session, requestID: again.reservationID, model: state.binding.model },
          next.target,
          root,
        )
        const binding = yield* state.voice.candidate(state.binding.id, again, secret, next.target, root)
        const context = yield* state.voice.handoffContext(binding.id, binding.generation, next.target, root)
        const ready = {
          ...next.ready,
          generation: binding.generation,
          sourceHash: context.sourceHash,
          sourceRevision: context.sourceRevision,
        }
        yield* state.voice.ready(binding.id, ready, next.target, root)
        const input = {
          ...ready,
          generation: state.binding.generation,
          requestID: again.requestID,
          candidateID: binding.id,
          candidateGeneration: binding.generation,
        }
        const saved = yield* retained(binding.id)
        yield* replace({
          ...saved,
          binding: { ...saved.binding, handoff: { ...saved.binding.handoff!, deadline: Date.now() - 1 } },
        })
        expect(
          Exit.isFailure(yield* state.voice.activate(state.binding.id, input, secret, root).pipe(Effect.exit)),
        ).toBe(true)
        expect(Exit.isFailure(yield* state.voice.ready(binding.id, ready, next.target, root).pipe(Effect.exit))).toBe(
          true,
        )
        const source = yield* retained(state.binding.id)
        yield* replace({
          ...source,
          calls: {
            pending: {
              input: state.input,
              receipt: {
                id: "pending",
                callID: state.input.callID,
                messageID: MessageID.ascending(),
                parentSessionID: session,
                status: "accepted",
                createdAt: Date.now(),
                updatedAt: Date.now(),
              },
            },
          },
        })
        yield* replace(saved)
        expect(
          Exit.isFailure(yield* state.voice.activate(state.binding.id, input, secret, root).pipe(Effect.exit)),
        ).toBe(true)
        expect(state.calls).toEqual([])
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
  "spoken full snapshots enforce exact revisions, monotone items and shared binding writes",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const state = yield* fixture(root)
        const input: typeof Spoken.Input.Type = {
          generation: state.binding.generation,
          providerCallID: state.binding.providerCallID,
          version: 1,
          revision: 1,
          items: [
            { id: "first", previous: null, role: "user", state: "final", text: "I am learning violin." },
            { id: "second", previous: "first", role: "assistant", state: "pending" },
            { id: "third", previous: "second", role: "user", state: "final", text: "My budget is 500 CAD." },
          ],
        }
        const first = yield* state.voice.spoken(state.binding.id, input, secret, root)
        expect(yield* state.voice.spoken(state.binding.id, input, secret, root)).toEqual(first)
        for (const changed of [
          { ...input, revision: 3 },
          { ...input, items: input.items.slice(1) },
          { ...input, providerCallID: "wrong" },
          { ...input, generation: "wrong" },
          { ...input, updatedAt: Date.now() + 1 },
          { ...input, revision: 2, items: [input.items[0]!, input.items[2]!] },
          { ...input, revision: 2, items: [{ ...input.items[0]!, text: "different" }, ...input.items.slice(1)] },
        ])
          expect(
            Exit.isFailure(yield* state.voice.spoken(state.binding.id, changed, secret, root).pipe(Effect.exit)),
          ).toBe(true)
        const next = {
          ...input,
          revision: 2,
          items: input.items.map((item) => (item.id === "second" ? { ...item, state: "omitted" as const } : item)),
        }
        const writes = yield* Effect.all(
          [
            state.voice.spoken(state.binding.id, next, secret, root),
            state.voice.spoken(state.binding.id, next, secret, root),
            state.voice.stage(
              state.binding.id,
              { generation: input.generation, id: "spoken-image", mime: "image/png", data: png },
              secret,
              root,
            ),
          ],
          { concurrency: "unbounded" },
        )
        expect(writes[0]).toEqual(writes[1])
        expect(Object.values((yield* retained(state.binding.id)).images ?? {}).map((item) => item.receipt.id)).toEqual([
          "spoken-image",
        ])
        expect(
          Exit.isFailure(
            yield* state.voice
              .spoken(
                state.binding.id,
                {
                  ...next,
                  revision: 3,
                  items: next.items.map((item) =>
                    item.id === "second" ? { ...item, state: "final" as const, text: "unheard" } : item,
                  ),
                },
                secret,
                root,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        const deleted = {
          ...next,
          revision: 3,
          incomplete: true,
          items: next.items.map((item) =>
            item.id === "first"
              ? { id: item.id, previous: item.previous, role: item.role, state: "omitted" as const }
              : item,
          ),
        }
        yield* state.voice.spoken(state.binding.id, deleted, secret, root)
        for (const text of [input.items[0]!.text, "replacement"])
          expect(
            Exit.isFailure(
              yield* state.voice
                .spoken(
                  state.binding.id,
                  { ...deleted, revision: 4, items: [{ ...input.items[0]!, text }, ...deleted.items.slice(1)] },
                  secret,
                  root,
                )
                .pipe(Effect.exit),
            ),
          ).toBe(true)
        const rolled = { ...deleted, revision: 4, items: deleted.items.slice(1) }
        yield* state.voice.spoken(state.binding.id, rolled, secret, root)
        expect((yield* retained(state.binding.id)).spoken?.items).toEqual(rolled.items)
        expect(state.calls).toHaveLength(0)
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
  "new active voice capability recovers only bounded recent same-task speech without adopting old owner",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const other = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const state = yield* fixture(root)
        yield* state.voice.spoken(
          state.binding.id,
          {
            generation: state.binding.generation,
            providerCallID: state.binding.providerCallID,
            version: 1,
            revision: 1,
            items: [
              { id: "second", previous: "first", role: "user", state: "final", text: "500 CAD" },
              { id: "first", previous: null, role: "user", state: "final", text: "Learn violin" },
              { id: "unheard", previous: "second", role: "assistant", state: "omitted" },
            ],
          },
          secret,
          root,
        )
        const saved = yield* retained(state.binding.id)
        yield* state.voice.spoken(
          state.binding.id,
          {
            generation: state.binding.generation,
            providerCallID: state.binding.providerCallID,
            version: 1,
            revision: 2,
            incomplete: true,
            items: saved.spoken!.items.map((item) =>
              item.id === "first"
                ? { id: item.id, previous: item.previous, role: item.role, state: "omitted" as const }
                : item,
            ),
          },
          secret,
          root,
        )
        const voice = yield* make(state.deps)
        const requestID = crypto.randomUUID()
        const key = "b".repeat(64)
        yield* voice.reserve({ parentSessionID: session, requestID, model: "gpt-realtime-2.1" }, key, root)
        const binding = yield* voice.start(
          { parentSessionID: session, requestID, providerCallID: crypto.randomUUID() },
          key,
          root,
        )
        expect(yield* voice.context(binding.id, binding.generation, key, root)).toEqual({
          version: 1,
          incomplete: true,
          items: [{ bindingID: state.binding.id, itemID: "second", role: "user", text: "500 CAD" }],
        })
        for (const request of [
          voice.context(binding.id, binding.generation, secret, root),
          voice.context(binding.id, "wrong", key, root),
          voice.context(binding.id, binding.generation, key, other),
          voice.context(state.binding.id, state.binding.generation, secret, root),
        ])
          expect(Exit.isFailure(yield* request.pipe(Effect.exit))).toBe(true)
        saved.spoken = (yield* retained(state.binding.id)).spoken
        saved.spoken = { ...saved.spoken!, updatedAt: Date.now() + 10_000 }
        yield* replace(saved)
        expect(yield* voice.context(binding.id, binding.generation, key, root)).toEqual({
          version: 1,
          items: [],
          incomplete: true,
        })
        expect((yield* retained(binding.id)).spoken).toBeUndefined()
        saved.spoken = {
          version: 1,
          revision: 1,
          updatedAt: Date.now(),
          incomplete: false,
          items: [0, 1, 2].map((index) => ({
            id: `large${index}`,
            previous: index ? `large${index - 1}` : null,
            role: "user" as const,
            state: "final" as const,
            text: `${index}`.repeat(4096),
          })),
        }
        yield* replace(saved)
        const tail = yield* voice.context(binding.id, binding.generation, key, root)
        expect(tail.incomplete).toBe(true)
        expect(tail.items.map((item) => item.itemID)).toEqual(["large1", "large2"])
        expect(tail.items.at(-1)?.text).toBe("2".repeat(4096))
        expect(state.calls).toHaveLength(0)
      }).pipe(
        Effect.provide([
          Storage.layerFromDir(path.join(root, "storage")),
          Database.layerFromPath(path.join(root, "voice.sqlite")),
        ]),
      )
    }),
  30_000,
)
type Prompt = Parameters<SessionPrompt.Interface["prompt"]>[0]

it.live(
  "cancellation dispatch occurs once and never adopts old-owner receipts",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const state = yield* fixture(root, () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        )
        const events: string[] = []
        const cancel = state.deps.workers.cancel
        // Observe calls while delegating every effect to the real worker cancellation service.
        state.deps.workers.cancel = (sid, message) =>
          Effect.sync(() => events.push(message)).pipe(Effect.andThen(cancel(sid, message)))
        const call = yield* state.voice.submit(state.binding.id, state.input, secret, root)
        yield* Deferred.await(entered)
        const first = yield* state.voice.cancel(
          state.binding.id,
          state.input.callID,
          state.binding.generation,
          secret,
          root,
        )
        expect(first.status).toBe("cancelled")
        expect(events).toEqual([call.messageID])
        expect(
          yield* state.voice.cancel(state.binding.id, state.input.callID, state.binding.generation, secret, root),
        ).toEqual(first)
        expect(events).toEqual([call.messageID])
        const restarted = yield* make(state.deps)
        expect(
          yield* restarted.cancel(state.binding.id, state.input.callID, state.binding.generation, secret, root),
        ).toEqual(first)
        expect(events).toEqual([call.messageID])
        const next = { ...state.input, callID: "second-call" }
        const pending = yield* state.voice.submit(state.binding.id, next, secret, root)
        expect(
          (yield* restarted.cancel(state.binding.id, next.callID, state.binding.generation, secret, root)).status,
        ).toBe("unknown")
        expect(events).toEqual([call.messageID])
        expect(
          (yield* state.voice.cancel(state.binding.id, next.callID, state.binding.generation, secret, root)).status,
        ).toBe("cancelled")
        expect(events).toEqual([call.messageID, pending.messageID])
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
  "abandoning a cancellation waiter does not abandon exact-message cleanup",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const cleanup = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const state = yield* fixture(root, () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(cleanup, undefined).pipe(Effect.andThen(Deferred.await(release)))),
          ),
        )
        yield* state.voice.submit(state.binding.id, state.input, secret, root)
        yield* Deferred.await(entered)
        const waiter = yield* state.voice
          .cancel(state.binding.id, state.input.callID, state.binding.generation, secret, root)
          .pipe(Effect.forkChild)
        yield* Deferred.await(cleanup)
        yield* Fiber.interrupt(waiter)
        yield* Deferred.succeed(release, undefined)
        const next = MessageID.ascending()
        const result = yield* state.runner.ensureRunning(
          Effect.gen(function* () {
            expect(yield* state.workers.bind(session, next)).toBe(true)
            return answer({ sessionID: session, messageID: next, parts: [] })
          }).pipe(Effect.ensuring(state.workers.release)),
        )
        expect(result.info.role === "assistant" && result.info.parentID).toBe(next)
        expect(
          (yield* state.voice.get(state.binding.id, state.input.callID, state.binding.generation, secret, root)).status,
        ).toBe("cancelled")
      }).pipe(
        Effect.provide([
          Storage.layerFromDir(path.join(root, "storage")),
          Database.layerFromPath(path.join(root, "voice.sqlite")),
        ]),
      )
    }),
  30_000,
)

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
      { id: PartID.ascending(), messageID: id, sessionID: input.sessionID, type: "text", text: "Verified response" },
    ],
  }
}

const retained = (id: string) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const storage = yield* Storage.Service
    return yield* Store.make(database, storage).read(id).pipe(Effect.orDie)
  })
const replace = (value: Store.Stored) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.update(Table).set({ data: value }).where(eq(Table.id, value.binding.id)).run().pipe(Effect.orDie)
  })

const fixture = (
  root: string,
  work: SessionPrompt.Interface["prompt"] = (input) => Effect.succeed(answer(input)),
  usageCharges?: (input: {
    sessionID: SessionID
    id: string
    callID: string
    at: number
    model: "gpt-realtime-2.1" | "gpt-live-transcribe"
    pricing: OpenAIPricing
  }) => Effect.Effect<void, VoiceError>,
  admissions?: (
    sessionID: SessionID,
    identity: string,
  ) => Effect.Effect<{
    amount?: number
    dispatch: Effect.Effect<void>
    finish: Effect.Effect<void>
    release: Effect.Effect<void>
  }>,
  completions?: (sessionID: SessionID, identity: string) => Effect.Effect<boolean>,
  usageSettlements?: (input: {
    sessionID: SessionID
    id: string
    callID: string
    at: number
    model: "gpt-realtime-2.1" | "gpt-live-transcribe"
    pricing: OpenAIPricing
    identity: string
  }) => Effect.Effect<void, VoiceError>,
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
        sql`INSERT OR IGNORE INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (${session}, 'voice-project', 'voice', ${root}, 'Voice test', 'test', 1, 1)`,
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
    const deps = {
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
      ...(usageCharges ? { usageCharges } : {}),
      ...(admissions ? { admissions } : {}),
      ...(completions ? { completions } : {}),
      ...(usageSettlements ? { usageSettlements } : {}),
    }
    const voice = yield* make(deps)
    const start = { parentSessionID: session, providerCallID: crypto.randomUUID(), requestID: crypto.randomUUID() }
    yield* voice.reserve(
      { parentSessionID: session, requestID: start.requestID, model: "gpt-realtime-2.1" },
      secret,
      root,
    )
    const binding = yield* voice.start(start, secret, root)
    const input: typeof OpenAICallInput.Type = {
      generation: binding.generation,
      callID: "call_test",
      function: "raya_work",
      arguments: { request: "Inspect the existing Raya task" },
    }
    return { voice, deps, binding, input, start, calls, workers, runner }
  })

it.live(
  "requires one matching preflight and releases definite refusals idempotently",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const events: string[] = []
        const admissions = (sessionID: SessionID, identity: string) =>
          Effect.succeed({
            dispatch: Effect.sync(() => events.push(`dispatch:${sessionID}:${identity}`)).pipe(Effect.asVoid),
            finish: Effect.sync(() => events.push(`finish:${sessionID}:${identity}`)).pipe(Effect.asVoid),
            release: Effect.sync(() => events.push(`release:${sessionID}:${identity}`)).pipe(Effect.asVoid),
          })
        const completions = (sessionID: SessionID, identity: string) =>
          Effect.sync(() => {
            events.push(`complete:${sessionID}:${identity}`)
            return true
          })
        const state = yield* fixture(root, undefined, undefined, admissions, completions)
        expect(events.map((event) => event.split(":")[0])).toEqual(["dispatch", "finish", "release"])
        events.length = 0
        const voice = yield* make({ ...state.deps, admissions })
        const requestID = crypto.randomUUID()
        const input = { parentSessionID: session, requestID, model: "gpt-realtime-2.1" as const }
        const start = { parentSessionID: session, requestID, providerCallID: crypto.randomUUID() }
        expect(Exit.isFailure(yield* voice.start(start, secret, root).pipe(Effect.exit))).toBe(true)
        expect(yield* voice.reserve(input, secret, root)).toEqual({
          requestID,
          model: "gpt-realtime-2.1",
          status: "reserved",
        })
        expect(yield* voice.reserve(input, secret, root)).toEqual({
          requestID,
          model: "gpt-realtime-2.1",
          status: "reserved",
        })
        expect(events.filter((event) => event.startsWith("dispatch:")).length).toBe(1)
        expect(
          Exit.isFailure(yield* voice.reserve({ ...input, model: "gpt-live-1" }, secret, root).pipe(Effect.exit)),
        ).toBe(true)
        expect(yield* voice.release(input, secret, root)).toEqual({
          requestID,
          model: "gpt-realtime-2.1",
          status: "released",
        })
        expect(yield* voice.release(input, secret, root)).toEqual({
          requestID,
          model: "gpt-realtime-2.1",
          status: "released",
        })
        expect(events.map((event) => event.split(":")[0])).toEqual(["dispatch", "finish", "release", "complete"])
        expect(Exit.isFailure(yield* voice.start(start, secret, root).pipe(Effect.exit))).toBe(true)
        const orphan = { ...input, requestID: crypto.randomUUID() }
        yield* voice.reserve(orphan, secret, root)
        const restarted = yield* make({ ...state.deps, admissions, completions })
        expect((yield* restarted.release(orphan, secret, root)).status).toBe("released")
        expect(events.filter((event) => event.startsWith(`complete:${session}:voice:`))).toHaveLength(2)
        const live = { ...orphan, requestID: crypto.randomUUID(), model: "gpt-live-1" as const }
        yield* voice.reserve(live, secret, root)
        expect(Exit.isFailure(yield* restarted.release(live, secret, root).pipe(Effect.exit))).toBe(true)
        expect(events.filter((event) => event.startsWith(`complete:${session}:voice:`))).toHaveLength(2)
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
  "serializes durable binding consumption against concurrent reservation release",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const state = yield* fixture(root)
        const entered = yield* Deferred.make<void>()
        const gate = yield* Deferred.make<void>()
        const events: string[] = []
        const voice = yield* make({
          ...state.deps,
          admissions: () =>
            Effect.succeed({
              dispatch: Effect.void,
              finish: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(gate))),
              release: Effect.sync(() => events.push("lease-released")).pipe(Effect.asVoid),
            }),
          completions: () =>
            Effect.sync(() => {
              events.push("durable-completion")
              return true
            }),
        })
        const requestID = crypto.randomUUID()
        const reserve = { parentSessionID: session, requestID, model: "gpt-realtime-2.1" as const }
        const start = { parentSessionID: session, requestID, providerCallID: crypto.randomUUID() }
        yield* voice.reserve(reserve, secret, root)
        const starting = yield* voice.start(start, secret, root).pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        const releasing = yield* voice.release(reserve, secret, root).pipe(Effect.forkChild)
        yield* Effect.sleep("20 millis")
        expect(events).toEqual([])
        yield* Deferred.succeed(gate, undefined)
        expect((yield* Fiber.join(starting)).providerCallID).toBe(start.providerCallID)
        expect((yield* Fiber.join(releasing)).status).toBe("released")
        expect(events).toEqual(["lease-released", "durable-completion"])
      }).pipe(
        Effect.provide([
          Storage.layerFromDir(path.join(root, "storage")),
          Database.layerFromPath(path.join(root, "voice.sqlite")),
        ]),
      )
    }),
  30_000,
)

const settled = (read: Effect.Effect<typeof OpenAICall.Type, unknown>) =>
  Effect.gen(function* () {
    for (const _ of Array.from({ length: 200 })) {
      const call = yield* read
      if (call.status !== "accepted" && call.status !== "running") return call
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.die("voice receipt did not settle")
  })

it.live(
  "retains one intent before dispatch, deduplicates concurrent calls and attributes the actual message",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        const entered = yield* Deferred.make<void>()
        const database = yield* Database.Service
        const store = Store.make(database, yield* Storage.Service)
        const state = yield* fixture(root, (input) =>
          Effect.gen(function* () {
            const rows = yield* database.db.select().from(Table).pipe(Effect.orDie)
            const stored = yield* store.read(rows[0].id)
            expect(Object.values(stored.calls)[0].receipt.status).toBe("running")
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(gate)
            return answer(input)
          }).pipe(Effect.orDie),
        )
        const calls = yield* Effect.all(
          Array.from({ length: 8 }, () => state.voice.submit(state.binding.id, state.input, secret, root)),
          { concurrency: "unbounded" },
        )
        expect(new Set(calls.map((call) => call.messageID)).size).toBe(1)
        yield* Deferred.await(entered)
        expect(state.calls).toHaveLength(1)
        expect(state.calls[0].sessionID).toBe(session)
        expect(state.calls[0].parts).toEqual([{ type: "text", text: state.input.arguments.request }])
        expect(
          Exit.isFailure(
            yield* state.voice
              .submit(state.binding.id, { ...state.input, arguments: { request: "different" } }, secret, root)
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* state.voice
              .submit(state.binding.id, { ...state.input, callID: "other" }, secret, root)
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        yield* Deferred.succeed(gate, undefined)
        const call = yield* settled(
          state.voice.get(state.binding.id, state.input.callID, state.binding.generation, secret, root),
        )
        expect(call.status).toBe("completed")
        expect(call.result?.text).toBe("Verified response")
        expect(call.messageID).toBe(calls[0].messageID)
        expect((yield* state.voice.submit(state.binding.id, state.input, secret, root)).status).toBe("completed")
        expect(state.calls).toHaveLength(1)
        const stored = yield* retained(state.binding.id)
        expect(JSON.stringify(stored)).not.toContain(secret)
        expect(JSON.stringify(stored)).toContain(createHash("sha256").update(secret).digest("hex"))
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
  "rejects capability, directory, generation and provider binding conflicts without dispatch",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const other = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const state = yield* fixture(root)
        expect((yield* state.voice.start(state.start, secret, root)).id).toBe(state.binding.id)
        for (const request of [
          state.voice.submit(state.binding.id, state.input, "b".repeat(64), root).pipe(Effect.asVoid),
          state.voice.submit(state.binding.id, state.input, secret, other).pipe(Effect.asVoid),
          state.voice
            .submit(state.binding.id, { ...state.input, generation: "stale" }, secret, root)
            .pipe(Effect.asVoid),
          state.voice.start({ ...state.start, requestID: "other" }, secret, root).pipe(Effect.asVoid),
        ])
          expect(Exit.isFailure(yield* request.pipe(Effect.exit))).toBe(true)
        expect(state.calls).toHaveLength(0)
        expect((yield* state.voice.close(state.binding.id, state.binding.generation, secret, root)).status).toBe(
          "closed",
        )
        expect(
          Exit.isFailure(yield* state.voice.submit(state.binding.id, state.input, secret, root).pipe(Effect.exit)),
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
  "cancels the owned message and rejects late results while preserving later typed work",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const state = yield* fixture(root, () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        )
        const call = yield* state.voice.submit(state.binding.id, state.input, secret, root)
        yield* Deferred.await(entered)
        expect(
          (yield* state.voice.cancel(state.binding.id, state.input.callID, state.binding.generation, secret, root))
            .status,
        ).toBe("cancelled")
        const next = MessageID.ascending()
        const typed = yield* state.runner.ensureRunning(
          Effect.gen(function* () {
            expect(yield* state.workers.bind(session, next)).toBe(true)
            yield* state.voice.cancel(state.binding.id, state.input.callID, state.binding.generation, secret, root)
            expect(observe(state.runner).phase).toBe("running")
            return answer({ sessionID: session, messageID: next, parts: [] })
          }).pipe(Effect.orDie, Effect.ensuring(state.workers.release)),
        )
        expect(typed.info.role === "assistant" && typed.info.parentID).toBe(next)
        expect(call.messageID).not.toBe(next)
        expect(
          (yield* state.voice.get(state.binding.id, state.input.callID, state.binding.generation, secret, root)).result,
        ).toBeUndefined()
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
  "does not attribute another parent turn and fences retained calls after owner restart",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const state = yield* fixture(root, (input) =>
          Effect.succeed(answer({ ...input, messageID: MessageID.ascending() })),
        )
        yield* state.voice.submit(state.binding.id, state.input, secret, root)
        const call = yield* settled(
          state.voice.get(state.binding.id, state.input.callID, state.binding.generation, secret, root),
        )
        expect(call.status).toBe("unknown")
        expect(call.error?.code).toBe("superseded")
        const next = yield* make(state.deps)
        expect((yield* next.start(state.start, secret, root)).status).toBe("closed")
        expect(
          (yield* next.get(state.binding.id, state.input.callID, state.binding.generation, secret, root)).status,
        ).toBe("unknown")
        expect(Exit.isFailure(yield* next.submit(state.binding.id, state.input, secret, root).pipe(Effect.exit))).toBe(
          true,
        )
        expect(state.calls).toHaveLength(1)
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
  "closing voice preserves admitted work and retained results, but refuses new calls",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const state = yield* fixture(root, (input) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            return answer(input)
          }),
        )
        yield* state.voice.submit(state.binding.id, state.input, secret, root)
        yield* Deferred.await(entered)
        expect((yield* state.voice.close(state.binding.id, state.binding.generation, secret, root)).status).toBe(
          "closed",
        )
        expect(observe(state.runner).phase).toBe("running")
        expect(
          Exit.isFailure(
            yield* state.voice
              .submit(state.binding.id, { ...state.input, callID: "late" }, secret, root)
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        yield* Deferred.succeed(release, undefined)
        expect(
          (yield* settled(
            state.voice.get(state.binding.id, state.input.callID, state.binding.generation, secret, root),
          )).status,
        ).toBe("completed")
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
  "an earlier owner's pending intent is inspectable as unknown and never readmitted",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const state = yield* fixture(root, (input) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            return answer(input)
          }),
        )
        yield* state.voice.submit(state.binding.id, state.input, secret, root)
        yield* Deferred.await(entered)
        const restarted = yield* make(state.deps)
        const call = yield* restarted.get(state.binding.id, state.input.callID, state.binding.generation, secret, root)
        expect(call.status).toBe("unknown")
        expect(call.error?.code).toBe("owner_lost")
        expect(
          Exit.isFailure(yield* restarted.submit(state.binding.id, state.input, secret, root).pipe(Effect.exit)),
        ).toBe(true)
        expect(state.calls).toHaveLength(1)
        yield* Deferred.succeed(release, undefined)
        yield* settled(state.voice.get(state.binding.id, state.input.callID, state.binding.generation, secret, root))
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
  "lease expiry refuses new admission without cancelling already-running parent work",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const state = yield* fixture(root, (input) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            return answer(input)
          }),
        )
        yield* state.voice.submit(state.binding.id, state.input, secret, root)
        yield* Deferred.await(entered)
        const stored = yield* retained(state.binding.id)
        yield* replace({ ...stored, binding: { ...stored.binding, expiresAt: Date.now() - 1 } })
        expect((yield* state.voice.start(state.start, secret, root)).status).toBe("closed")
        expect(
          Exit.isFailure(
            yield* state.voice
              .submit(state.binding.id, { ...state.input, callID: "expired" }, secret, root)
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(observe(state.runner).phase).toBe("running")
        yield* Deferred.succeed(release, undefined)
        expect(
          (yield* settled(
            state.voice.get(state.binding.id, state.input.callID, state.binding.generation, secret, root),
          )).status,
        ).toBe("completed")
      }).pipe(
        Effect.provide([
          Storage.layerFromDir(path.join(root, "storage")),
          Database.layerFromPath(path.join(root, "voice.sqlite")),
        ]),
      )
    }),
  30_000,
)

for (const mode of ["failed", "pending", "running", "completed", "untimed"] as const) {
  it.live(
    `terminal tool-call receipts retain ${mode === "failed" ? "settled failure" : `${mode} uncertainty`} without replay`,
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped()
        yield* Effect.gen(function* () {
          const messages: MessageV2.WithParts[] = []
          const state = yield* fixture(root, (input) => {
            const message = answer(input)
            if (message.info.role !== "assistant") return Effect.die("Expected assistant fixture")
            message.info.finish = "tool-calls"
            if (mode === "untimed") delete message.info.time.completed
            const failed: MessageV2.ToolPart = {
              id: PartID.ascending(),
              messageID: message.info.id,
              sessionID: input.sessionID,
              type: "tool",
              callID: "refused_edit",
              tool: "edit",
              state: {
                status: "error",
                input: { filePath: "voice-permission.txt" },
                error: "The user rejected permission to use this specific tool call.",
                time: { start: 1, end: 2 },
              },
            }
            const sibling: MessageV2.ToolPart = {
              ...failed,
              id: PartID.ascending(),
              callID: "observed_read",
              tool: "read",
              state:
                mode === "pending"
                  ? { status: "pending", input: {}, raw: "" }
                  : mode === "running"
                    ? { status: "running", input: {}, time: { start: 1 } }
                    : {
                        status: "completed",
                        input: {},
                        output: "Observed file contents",
                        title: "Read file",
                        metadata: {},
                        time: { start: 1, end: 2 },
                      },
            }
            message.parts = [...message.parts, ...(mode === "completed" ? [] : [failed]), sibling]
            messages.push(message)
            return Effect.succeed(message)
          })
          yield* state.voice.submit(state.binding.id, state.input, secret, root)
          const call = yield* settled(
            state.voice.get(state.binding.id, state.input.callID, state.binding.generation, secret, root),
          )
          expect(call.status).toBe(mode === "failed" ? "failed" : "unknown")
          expect(call.error?.code).toBe(mode === "failed" ? "tool_failed" : "incomplete")
          if (mode === "failed") {
            expect(call.result).toEqual({
              text: "Verified response",
              assistantMessageID: messages[0]!.info.id,
              evidence: messages[0]!.parts
                .filter((part) => part.type === "tool")
                .map((part) => ({
                  messageID: part.messageID,
                  partID: part.id,
                  tool: part.tool,
                  status: part.state.status,
                })),
            })
            expect(call.error?.message).toContain("stopped")
          } else expect(call.result).toBeUndefined()
          expect(yield* state.voice.submit(state.binding.id, state.input, secret, root)).toEqual(call)
          expect(
            yield* state.voice.get(state.binding.id, state.input.callID, state.binding.generation, secret, root),
          ).toEqual(call)
          expect(state.calls).toHaveLength(1)
        }).pipe(
          Effect.provide([
            Storage.layerFromDir(path.join(root, "storage")),
            Database.layerFromPath(path.join(root, "voice.sqlite")),
          ]),
        )
      }),
    30_000,
  )
}

it.live(
  "bounds result text and keeps only exact observed tool identities",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const state = yield* fixture(root, (input) => {
          const message = answer(input)
          const text: MessageV2.TextPart = {
            id: PartID.ascending(),
            messageID: message.info.id,
            sessionID: input.sessionID,
            type: "text",
            text: "x".repeat(13000),
          }
          const tools: MessageV2.ToolPart[] = Array.from({ length: 70 }, (_, index) => ({
            id: PartID.ascending(),
            messageID: message.info.id,
            sessionID: input.sessionID,
            type: "tool",
            callID: `tool_${index}`,
            tool: index === 0 ? "x".repeat(129) : `observed_${index}`,
            state: {
              status: "completed",
              input: {},
              output: "tool result",
              title: "actual fixture receipt",
              metadata: {},
              time: { start: 1, end: 2 },
            },
          }))
          return Effect.succeed({ info: message.info, parts: [text, ...tools] })
        })
        yield* state.voice.submit(state.binding.id, state.input, secret, root)
        const call = yield* settled(
          state.voice.get(state.binding.id, state.input.callID, state.binding.generation, secret, root),
        )
        expect(call.status).toBe("completed")
        expect(call.result!.text.length).toBeLessThanOrEqual(12000)
        expect(call.result!.text).toContain("Response shortened")
        expect(call.result!.evidence).toHaveLength(64)
        expect(call.result!.evidence[0].tool).toBe("observed_1")
        expect(call.result!.evidence.every((part) => part.messageID === call.result!.assistantMessageID)).toBe(true)
      }).pipe(
        Effect.provide([
          Storage.layerFromDir(path.join(root, "storage")),
          Database.layerFromPath(path.join(root, "voice.sqlite")),
        ]),
      )
    }),
  30_000,
)

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6p8AAAAASUVORK5CYII="

it.live(
  "stages immutable bound images without work and dispatches only their verified bytes",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const state = yield* fixture(root)
        const input = { generation: state.binding.generation, id: "image-one", mime: "image/png" as const, data: png }
        const uploads = yield* Effect.all(
          [
            state.voice.stage(state.binding.id, input, secret, root),
            state.voice.stage(state.binding.id, input, secret, root),
          ],
          { concurrency: "unbounded" },
        )
        expect(uploads[0]).toEqual(uploads[1])
        expect(uploads[0]).toEqual({
          id: input.id,
          mime: input.mime,
          bytes: Buffer.from(png, "base64").length,
          sha256: createHash("sha256").update(Buffer.from(png, "base64")).digest("hex"),
        })
        expect(state.calls).toEqual([])
        const altered = Buffer.from(png, "base64")
        altered[30] ^= 1
        expect(
          Exit.isFailure(
            yield* state.voice
              .stage(state.binding.id, { ...input, data: altered.toString("base64") }, secret, root)
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        const request = {
          ...state.input,
          arguments: { request: "Inspect this explicitly attached image", images: [input.id] },
        }
        const accepted = yield* state.voice.submit(state.binding.id, request, secret, root)
        const result = yield* settled(
          state.voice.get(state.binding.id, request.callID, state.binding.generation, secret, root),
        )
        expect(result.status).toBe("completed")
        expect(result.images).toEqual([uploads[0]])
        expect(state.calls[0]?.messageID).toBe(accepted.messageID)
        expect(state.calls[0]?.parts).toEqual([
          { type: "text", text: request.arguments.request },
          { type: "file", mime: "image/png", url: `data:image/png;base64,${png}` },
        ])
        yield* state.voice.submit(state.binding.id, request, secret, root)
        expect(state.calls.length).toBe(1)
        expect(
          Exit.isFailure(
            yield* state.voice
              .submit(state.binding.id, { ...request, arguments: { ...request.arguments, images: [] } }, secret, root)
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
  "image staging enforces format, capacity, owner and selection boundaries with actual storage",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const other = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const state = yield* fixture(root)
        const input = { generation: state.binding.generation, id: "image-one", mime: "image/png" as const, data: png }
        for (const data of ["", png + "\n", png.replace(/=$/, ""), "!!!!", Buffer.alloc(262145).toString("base64")])
          expect(
            Exit.isFailure(
              yield* state.voice.stage(state.binding.id, { ...input, data }, secret, root).pipe(Effect.exit),
            ),
          ).toBe(true)
        for (const mime of ["image/jpeg", "image/webp"] as const)
          expect(
            Exit.isFailure(
              yield* state.voice.stage(state.binding.id, { ...input, mime }, secret, root).pipe(Effect.exit),
            ),
          ).toBe(true)
        expect(
          Exit.isFailure(yield* state.voice.stage(state.binding.id, input, "b".repeat(64), root).pipe(Effect.exit)),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* state.voice
              .stage(state.binding.id, { ...input, generation: "stale" }, secret, root)
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(Exit.isFailure(yield* state.voice.stage(state.binding.id, input, secret, other).pipe(Effect.exit))).toBe(
          true,
        )
        for (const id of Array.from({ length: 8 }, (_, i) => `image-${i}`))
          yield* state.voice.stage(state.binding.id, { ...input, id }, secret, root)
        expect(Exit.isFailure(yield* state.voice.stage(state.binding.id, input, secret, root).pipe(Effect.exit))).toBe(
          true,
        )
        yield* state.voice.stage(state.binding.id, { ...input, id: "image-0" }, secret, root)
        expect(state.calls).toEqual([])
        for (const ids of [
          ["missing"],
          ["image-0", "image-0"],
          ["image-0", "image-1", "image-2", "image-3", "image-4"],
        ])
          expect(
            Exit.isFailure(
              yield* state.voice
                .submit(
                  state.binding.id,
                  { ...state.input, arguments: { request: "Check", images: ids } },
                  secret,
                  root,
                )
                .pipe(Effect.exit),
            ),
          ).toBe(true)
        const value = yield* retained(state.binding.id)
        const id = createHash("sha256").update("image-0").digest("hex")
        yield* replace({ ...value, images: { ...value.images, [id]: { ...value.images![id], data: "corrupted" } } })
        expect(
          Exit.isFailure(
            yield* state.voice
              .submit(
                state.binding.id,
                { ...state.input, arguments: { request: "Check", images: ["image-0"] } },
                secret,
                root,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        yield* state.voice.close(state.binding.id, state.binding.generation, secret, root)
        yield* state.voice.reserve(
          { parentSessionID: session, requestID: state.start.requestID, model: "gpt-realtime-2.1" },
          secret,
          root,
        )
        const second = yield* state.voice.start({ ...state.start, providerCallID: crypto.randomUUID() }, secret, root)
        expect(
          Exit.isFailure(
            yield* state.voice
              .submit(
                second.id,
                { ...state.input, generation: second.generation, arguments: { request: "Check", images: ["image-0"] } },
                secret,
                root,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        const restarted = yield* make(state.deps)
        expect(Exit.isFailure(yield* restarted.stage(state.binding.id, input, secret, root).pipe(Effect.exit))).toBe(
          true,
        )
        yield* state.voice.close(state.binding.id, state.binding.generation, secret, root)
        expect(Exit.isFailure(yield* state.voice.stage(state.binding.id, input, secret, root).pipe(Effect.exit))).toBe(
          true,
        )
        expect(state.calls).toEqual([])
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
  "voice usage receipts are immutable, scoped, retained after closure and never dispatch work",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const state = yield* fixture(root)
        const receipt = {
          id: "response_1",
          kind: "response" as const,
          model: "gpt-realtime-2.1" as const,
          status: "reported" as const,
          tokens: { input: 12, output: 3, total: 15, cached: 4, inputText: 4, inputAudio: 8 },
        }
        const input = { generation: state.binding.generation, receipt }
        expect(yield* state.voice.usage(state.binding.id, input.generation, secret, root)).toEqual({ receipts: [] })
        expect(yield* state.voice.meter(state.binding.id, input, secret, root)).toEqual(receipt)
        expect(
          yield* state.voice.meter(
            state.binding.id,
            {
              ...input,
              receipt: {
                ...receipt,
                tokens: { total: 15, output: 3, input: 12, inputAudio: 8, inputText: 4, cached: 4 },
              },
            },
            secret,
            root,
          ),
        ).toEqual(receipt)
        expect(
          Exit.isFailure(
            yield* state.voice
              .meter(
                state.binding.id,
                { ...input, receipt: { ...receipt, tokens: { input: 13, output: 3, total: 16 } } },
                secret,
                root,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* state.voice
              .meter(state.binding.id, { ...input, generation: "stale" }, secret, root)
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* state.voice.usage(state.binding.id, input.generation, "b".repeat(64), root).pipe(Effect.exit),
          ),
        ).toBe(true)
        const missing = {
          id: "transcript_1",
          kind: "transcription" as const,
          model: "gpt-live-transcribe" as const,
          status: "missing" as const,
        }
        yield* state.voice.meter(state.binding.id, { ...input, receipt: missing }, secret, root)
        const duration = {
          id: "duration_1",
          kind: "transcription" as const,
          model: "gpt-live-transcribe" as const,
          status: "reported" as const,
          seconds: 2.75,
        }
        yield* state.voice.meter(state.binding.id, { ...input, receipt: duration }, secret, root)
        expect(state.calls).toEqual([])
        yield* state.voice.close(state.binding.id, input.generation, secret, root)
        expect((yield* state.voice.usage(state.binding.id, input.generation, secret, root)).receipts).toEqual([
          receipt,
          missing,
          duration,
        ])
        expect(
          Exit.isFailure(
            yield* state.voice
              .meter(state.binding.id, { ...input, receipt: { ...receipt, id: "later" } }, secret, root)
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        const restarted = yield* make(state.deps)
        expect((yield* restarted.usage(state.binding.id, input.generation, secret, root)).receipts).toHaveLength(3)
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
  "voice usage rejects inconsistent counts and unknown reports cannot masquerade as measured zero",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const state = yield* fixture(root)
        const receipt = {
          id: "response_1",
          kind: "response" as const,
          model: "gpt-realtime-2.1" as const,
          status: "reported" as const,
          tokens: { input: 5, output: 2, total: 7 },
        }
        const input = { generation: state.binding.generation, receipt }
        for (const tokens of [
          { input: -1, output: 2, total: 1 },
          { input: 5, output: 2, total: 9 },
          { input: 5, output: 2, total: 7, cached: 6 },
          { input: 5, output: 2, total: 7, inputAudio: 6 },
          { input: 5, output: 2, total: 7, outputAudio: 3 },
        ])
          expect(
            Exit.isFailure(
              yield* state.voice
                .meter(state.binding.id, { ...input, receipt: { ...receipt, tokens } }, secret, root)
                .pipe(Effect.exit),
            ),
          ).toBe(true)
        expect(
          Exit.isFailure(
            yield* state.voice
              .meter(state.binding.id, { ...input, receipt: { ...receipt, status: "missing" } }, secret, root)
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* state.voice
              .meter(
                state.binding.id,
                { ...input, receipt: { ...receipt, model: "gpt-live-transcribe" } },
                secret,
                root,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect((yield* state.voice.usage(state.binding.id, input.generation, secret, root)).receipts).toEqual([])
        yield* state.voice.meter(state.binding.id, input, secret, root)
        const value = yield* retained(state.binding.id)
        const corrupted = { ...value, usage: { ...value.usage, corrupted: receipt } }
        yield* replace(corrupted)
        expect(
          Exit.isFailure(yield* state.voice.usage(state.binding.id, input.generation, secret, root).pipe(Effect.exit)),
        ).toBe(true)
        expect(Exit.isFailure(yield* state.voice.meter(state.binding.id, input, secret, root).pipe(Effect.exit))).toBe(
          true,
        )
        expect(
          Exit.isFailure(
            yield* state.voice
              .meter(state.binding.id, { ...input, receipt: { ...receipt, id: "new" } }, secret, root)
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect((yield* retained(state.binding.id)).usage).toEqual(corrupted.usage)
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
  "voice usage publishes stable priced and unknown goal charges and reconciles identical retries",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const charges: Array<{
          id: string
          model: string
          pricing: OpenAIPricing
        }> = []
        const state = yield* fixture(root, undefined, (input) =>
          Effect.sync(() => charges.push({ id: input.id, model: input.model, pricing: input.pricing })).pipe(
            Effect.asVoid,
          ),
        )
        const receipt = {
          id: "response_priced",
          kind: "response" as const,
          model: "gpt-realtime-2.1" as const,
          status: "reported" as const,
          tokens: {
            input: 100,
            output: 20,
            total: 120,
            cached: 10,
            inputText: 40,
            inputAudio: 50,
            inputImage: 10,
            cachedText: 4,
            cachedAudio: 5,
            cachedImage: 1,
            outputText: 8,
            outputAudio: 12,
          },
        }
        const input = { generation: state.binding.generation, receipt }
        yield* state.voice.meter(state.binding.id, input, secret, root)
        yield* state.voice.meter(state.binding.id, input, secret, root)
        yield* state.voice.meter(
          state.binding.id,
          {
            generation: state.binding.generation,
            receipt: {
              id: "response_missing",
              kind: "response",
              model: "gpt-realtime-2.1",
              status: "missing",
            },
          },
          secret,
          root,
        )

        expect(charges).toHaveLength(3)
        expect(charges[0]).toEqual(charges[1])
        expect(charges[0]).toMatchObject({
          id: `openai-voice:${state.binding.id}:response:response_priced`,
          model: "gpt-realtime-2.1",
          pricing: { coverage: "recorded", currency: "USD", quantity: 120, unit: "tokens" },
        })
        expect(charges[2]).toMatchObject({
          id: `openai-voice:${state.binding.id}:response:response_missing`,
          pricing: { coverage: "unknown" },
        })
        expect("amount" in charges[2]!.pricing).toBe(false)
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
  "authenticated usage inspection reconciles historical charges and retries a failed publication",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const state = yield* fixture(root)
        const receipt = {
          id: "historical_response",
          kind: "response" as const,
          model: "gpt-realtime-2.1" as const,
          status: "reported" as const,
          tokens: {
            input: 3,
            output: 2,
            total: 5,
            cached: 0,
            inputText: 3,
            inputAudio: 0,
            inputImage: 0,
            cachedText: 0,
            cachedAudio: 0,
            cachedImage: 0,
            outputText: 2,
            outputAudio: 0,
          },
        }
        yield* state.voice.meter(state.binding.id, { generation: state.binding.generation, receipt }, secret, root)

        const seen: Array<{ id: string; pricing: OpenAIPricing }> = []
        let fail = true
        const restarted = yield* make({
          ...state.deps,
          usageCharges: (input) =>
            Effect.gen(function* () {
              seen.push({ id: input.id, pricing: input.pricing })
              if (!fail) return
              fail = false
              return yield* Effect.fail(new VoiceError({ code: "conflict", message: "Injected publication failure." }))
            }),
        })

        expect(
          Exit.isFailure(
            yield* restarted.usage(state.binding.id, state.binding.generation, "b".repeat(64), root).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(yield* restarted.usage(state.binding.id, "stale-generation", secret, root).pipe(Effect.exit)),
        ).toBe(true)
        expect(seen).toEqual([])

        expect(
          Exit.isFailure(
            yield* restarted.usage(state.binding.id, state.binding.generation, secret, root).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(seen).toHaveLength(1)
        expect(yield* restarted.usage(state.binding.id, state.binding.generation, secret, root)).toEqual({
          receipts: [receipt],
        })
        expect(yield* restarted.usage(state.binding.id, state.binding.generation, secret, root)).toEqual({
          receipts: [receipt],
        })
        expect(seen).toHaveLength(3)
        expect(seen[0]).toEqual(seen[1])
        expect(seen[1]).toEqual(seen[2])
        expect(seen[2]).toMatchObject({
          id: `openai-voice:${state.binding.id}:response:historical_response`,
          pricing: { coverage: "recorded", currency: "USD", quantity: 5, unit: "tokens" },
        })
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
  "retains exact response reservation settlement across a lost acknowledgement and backend restart",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const events: string[] = []
        const settled: Array<{ id: string; identity: string }> = []
        let fail = true
        const admissions = (sessionID: SessionID, identity: string) =>
          Effect.succeed({
            amount: 0.6,
            dispatch: Effect.sync(() => events.push(`dispatch:${sessionID}:${identity}`)).pipe(Effect.asVoid),
            finish: Effect.sync(() => events.push(`finish:${sessionID}:${identity}`)).pipe(Effect.asVoid),
            release: Effect.sync(() => events.push(`release:${sessionID}:${identity}`)).pipe(Effect.asVoid),
          })
        const settlements = (input: { id: string; identity: string }) =>
          Effect.gen(function* () {
            settled.push({ id: input.id, identity: input.identity })
            if (!fail) return
            fail = false
            return yield* Effect.fail(new VoiceError({ code: "conflict", message: "Lost settlement acknowledgement." }))
          })
        const state = yield* fixture(root, undefined, undefined, admissions, undefined, settlements)
        const reservationID = crypto.randomUUID()
        yield* state.voice.reserve(
          { parentSessionID: session, requestID: reservationID, model: "gpt-realtime-2.1" },
          secret,
          root,
        )
        const receipt = {
          id: "response_reserved",
          kind: "response" as const,
          model: "gpt-realtime-2.1" as const,
          status: "reported" as const,
          tokens: {
            input: 3,
            output: 2,
            total: 5,
            cached: 0,
            inputText: 3,
            inputAudio: 0,
            inputImage: 0,
            cachedText: 0,
            cachedAudio: 0,
            cachedImage: 0,
            outputText: 2,
            outputAudio: 0,
          },
        }
        const input = { generation: state.binding.generation, receipt, reservationID }
        expect(Exit.isFailure(yield* state.voice.meter(state.binding.id, input, secret, root).pipe(Effect.exit))).toBe(
          true,
        )
        const stored = yield* retained(state.binding.id)
        expect(stored.usageReservations).toEqual({
          [createHash("sha256").update(`response:${receipt.id}`).digest("hex")]: settled[0]!.identity,
        })
        expect(
          Exit.isFailure(
            yield* state.voice
              .meter(state.binding.id, { ...input, reservationID: crypto.randomUUID() }, secret, root)
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        const restarted = yield* make({ ...state.deps, usageSettlements: settlements })
        expect(yield* restarted.usage(state.binding.id, state.binding.generation, secret, root)).toEqual({
          receipts: [receipt],
        })
        expect(settled).toHaveLength(2)
        expect(settled[0]).toEqual(settled[1])
        expect(events.filter((event) => event.startsWith("dispatch:"))).toHaveLength(2)
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
  "reconciles one bound transcription aggregate after a lost close acknowledgement and backend restart",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const events: string[] = []
        const settled: Array<{ id: string; identity: string; pricing: OpenAIPricing }> = []
        let fail = true
        const admissions = (sessionID: SessionID, identity: string) =>
          Effect.succeed({
            amount: 0.6,
            dispatch: Effect.sync(() => events.push(`dispatch:${sessionID}:${identity}`)).pipe(Effect.asVoid),
            finish: Effect.sync(() => events.push(`finish:${sessionID}:${identity}`)).pipe(Effect.asVoid),
            release: Effect.sync(() => events.push(`release:${sessionID}:${identity}`)).pipe(Effect.asVoid),
          })
        const settlements = (input: { id: string; identity: string; pricing: OpenAIPricing }) =>
          Effect.gen(function* () {
            settled.push({ id: input.id, identity: input.identity, pricing: input.pricing })
            if (!fail) return
            fail = false
            yield* Effect.fail(new VoiceError({ code: "conflict", message: "Lost aggregate acknowledgement." }))
          })
        const state = yield* fixture(root, undefined, undefined, admissions, undefined, settlements)
        yield* state.voice.close(state.binding.id, state.binding.generation, secret, root)
        const requestID = "transcription_guarded_start"
        const transcriptionRequestID = "transcription_guarded_total"
        yield* state.voice.reserve({ parentSessionID: session, requestID, model: "gpt-realtime-2.1" }, secret, root)
        yield* state.voice.reserve(
          { parentSessionID: session, requestID: transcriptionRequestID, model: "gpt-live-transcribe" },
          secret,
          root,
        )
        const binding = yield* state.voice.start(
          { parentSessionID: session, providerCallID: crypto.randomUUID(), requestID, transcriptionRequestID },
          secret,
          root,
        )
        for (const [id, seconds] of [
          ["speech_first", 2.75],
          ["speech_second", 3.25],
        ] as const)
          yield* state.voice.meter(
            binding.id,
            {
              generation: binding.generation,
              receipt: {
                id,
                kind: "transcription",
                model: "gpt-live-transcribe",
                status: "reported",
                seconds,
              },
            },
            secret,
            root,
          )
        expect(
          Exit.isFailure(yield* state.voice.close(binding.id, binding.generation, secret, root).pipe(Effect.exit)),
        ).toBe(true)
        expect((yield* retained(binding.id)).binding.status).toBe("closed")
        const restarted = yield* make({ ...state.deps, admissions, usageSettlements: settlements })
        expect((yield* restarted.reconcile(32)).status).toBe("complete")
        expect(settled).toHaveLength(2)
        expect(settled[0]).toEqual(settled[1])
        expect(settled[1]).toMatchObject({
          id: `openai-voice:${binding.id}:transcription-total`,
          pricing: {
            coverage: "recorded",
            amount: 0.0017,
            currency: "USD",
            quantity: 6,
            unit: "seconds",
            source: "openai-model-doc:gpt-live-transcribe:2026-09-14",
          },
        })
        const unknownRequestID = "transcription_unknown_start"
        const unknownTranscriptionRequestID = "transcription_unknown_total"
        yield* restarted.reserve(
          { parentSessionID: session, requestID: unknownRequestID, model: "gpt-realtime-2.1" },
          secret,
          root,
        )
        yield* restarted.reserve(
          {
            parentSessionID: session,
            requestID: unknownTranscriptionRequestID,
            model: "gpt-live-transcribe",
          },
          secret,
          root,
        )
        const unknown = yield* restarted.start(
          {
            parentSessionID: session,
            providerCallID: crypto.randomUUID(),
            requestID: unknownRequestID,
            transcriptionRequestID: unknownTranscriptionRequestID,
          },
          secret,
          root,
        )
        yield* restarted.meter(
          unknown.id,
          {
            generation: unknown.generation,
            receipt: {
              id: "speech_missing",
              kind: "transcription",
              model: "gpt-live-transcribe",
              status: "missing",
            },
          },
          secret,
          root,
        )
        yield* restarted.close(unknown.id, unknown.generation, secret, root)
        expect(settled).toHaveLength(3)
        expect(settled[2]).toMatchObject({
          id: `openai-voice:${unknown.id}:transcription-total`,
          pricing: {
            coverage: "unknown",
            source: "openai-model-doc:gpt-live-transcribe:2026-09-14",
          },
        })
        expect("amount" in settled[2].pricing).toBe(false)
        expect(events.filter((event) => event.startsWith("dispatch:"))).toHaveLength(5)
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
  "bounded startup reconciliation resumes its cursor, quarantines malformed rows and retries stable charges",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const states = [yield* fixture(root), yield* fixture(root), yield* fixture(root)].toSorted((one, two) =>
          one.binding.id.localeCompare(two.binding.id),
        )
        for (const state of states)
          yield* state.voice.meter(
            state.binding.id,
            {
              generation: state.binding.generation,
              receipt: {
                id: `usage_${state.binding.id}`,
                kind: "response",
                model: "gpt-realtime-2.1",
                status: "reported",
                tokens: {
                  input: 2,
                  output: 1,
                  total: 3,
                  cached: 0,
                  inputText: 2,
                  inputAudio: 0,
                  inputImage: 0,
                  cachedText: 0,
                  cachedAudio: 0,
                  cachedImage: 0,
                  outputText: 1,
                  outputAudio: 0,
                },
              },
            },
            secret,
            root,
          )
        yield* states[0]!.voice.meter(
          states[0]!.binding.id,
          {
            generation: states[0]!.binding.generation,
            receipt: {
              id: `missing_${states[0]!.binding.id}`,
              kind: "response",
              model: "gpt-realtime-2.1",
              status: "missing",
            },
          },
          secret,
          root,
        )
        const { db } = yield* Database.Service
        yield* db
          .update(Table)
          .set({ data: { invalid: true } })
          .where(eq(Table.id, states[1]!.binding.id))
          .run()
          .pipe(Effect.orDie)

        const seen: string[] = []
        let attempts = 0
        const publish = (input: { id: string }) =>
          Effect.gen(function* () {
            seen.push(input.id)
            attempts++
            if (attempts !== 2) return
            return yield* Effect.fail(new VoiceError({ code: "conflict", message: "Injected historical failure." }))
          })
        const first = yield* make({ ...states[0]!.deps, usageCharges: publish })
        expect(Exit.isFailure(yield* first.reconcile(0).pipe(Effect.exit))).toBe(true)
        expect(seen).toEqual([])
        expect(yield* first.reconcile(1)).toMatchObject({
          cycle: 1,
          status: "failed",
          scanned: 0,
          receipts: 0,
          quarantined: 0,
          failure: { id: states[0]!.binding.id },
        })

        const restarted = yield* make({ ...states[0]!.deps, usageCharges: publish })
        expect(yield* restarted.reconcile(1)).toMatchObject({
          cycle: 1,
          status: "running",
          after: states[0]!.binding.id,
          scanned: 1,
          receipts: 2,
          quarantined: 0,
        })
        expect(yield* restarted.reconcile(1)).toMatchObject({
          cycle: 1,
          status: "running",
          after: states[1]!.binding.id,
          scanned: 2,
          receipts: 2,
          quarantined: 1,
        })
        expect(yield* restarted.reconcile(1)).toMatchObject({
          cycle: 1,
          status: "complete",
          after: states[2]!.binding.id,
          scanned: 3,
          receipts: 3,
          quarantined: 1,
        })
        expect(seen).toHaveLength(5)
        expect(seen[0]).toBe(seen[2])
        expect(seen[1]).toBe(seen[3])
        expect(seen[4]).toContain(states[2]!.binding.id)

        const storage = yield* Storage.Service
        expect(
          yield* storage.read([
            "raya",
            "voice",
            "usage-reconciliation",
            "quarantine",
            createHash("sha256").update(states[1]!.binding.id).digest("hex"),
          ]),
        ).toMatchObject({ version: 1, id: states[1]!.binding.id, reason: "The retained voice binding is invalid." })
        yield* storage.replace(["raya", "voice", "usage-reconciliation", "v1"], { invalid: true }).pipe(Effect.orDie)
        expect(Exit.isFailure(yield* restarted.reconcile(1).pipe(Effect.exit))).toBe(true)
        expect(seen).toHaveLength(5)
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
  "a completed reconciliation cycle includes later bindings on the next activation and tolerates parent deletion",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const seen: string[] = []
        const publish = (input: { id: string }) => Effect.sync(() => seen.push(input.id)).pipe(Effect.asVoid)
        const first = yield* fixture(root)
        yield* first.voice.meter(
          first.binding.id,
          {
            generation: first.binding.generation,
            receipt: {
              id: "before_cycle",
              kind: "response",
              model: "gpt-realtime-2.1",
              status: "missing",
            },
          },
          secret,
          root,
        )
        const initial = yield* make({ ...first.deps, usageCharges: publish })
        expect(yield* initial.reconcile(2)).toMatchObject({ cycle: 1, status: "complete", scanned: 1, receipts: 1 })

        const later = yield* fixture(root)
        yield* later.voice.meter(
          later.binding.id,
          {
            generation: later.binding.generation,
            receipt: { id: "after_cycle", kind: "response", model: "gpt-realtime-2.1", status: "missing" },
          },
          secret,
          root,
        )
        const restarted = yield* make({ ...first.deps, usageCharges: publish })
        expect(yield* restarted.reconcile(2)).toMatchObject({ cycle: 2, status: "complete", scanned: 2, receipts: 2 })
        expect(seen.some((id) => id.endsWith(":response:after_cycle"))).toBe(true)

        const { db } = yield* Database.Service
        yield* db.delete(SessionTable).where(eq(SessionTable.id, session)).run().pipe(Effect.orDie)
        expect(yield* restarted.reconcile(2)).toMatchObject({ cycle: 3, status: "complete", scanned: 0, receipts: 0 })
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
  "migrates legacy receipts once, preserves old ownership, and prefers SQL over a leftover JSON copy",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const state = yield* fixture(root)
        yield* state.voice.stage(
          state.binding.id,
          { generation: state.binding.generation, id: "legacy-image", mime: "image/png", data: png },
          secret,
          root,
        )
        yield* state.voice.meter(
          state.binding.id,
          {
            generation: state.binding.generation,
            receipt: {
              id: "legacy-usage",
              kind: "response",
              model: "gpt-realtime-2.1",
              status: "reported",
              tokens: { input: 2, output: 1, total: 3 },
            },
          },
          secret,
          root,
        )
        yield* state.voice.submit(state.binding.id, state.input, secret, root)
        const call = yield* settled(
          state.voice.get(state.binding.id, state.input.callID, state.binding.generation, secret, root),
        )
        const value = yield* retained(state.binding.id)
        const key = ["raya_openai_voice", state.binding.id]
        const db = state.deps.database.db
        expect(yield* state.deps.storage.list(["raya_openai_voice"])).toEqual([])
        yield* state.deps.storage.create(key, value)
        yield* db.delete(Table).where(eq(Table.id, state.binding.id)).run().pipe(Effect.orDie)
        const reopened = yield* make(state.deps)
        expect(
          yield* reopened.get(state.binding.id, state.input.callID, state.binding.generation, secret, root),
        ).toEqual(call)
        expect((yield* reopened.start(state.start, secret, root)).status).toBe("closed")
        expect(yield* retained(state.binding.id)).toEqual(value)
        expect(yield* state.deps.storage.list(["raya_openai_voice"])).toEqual([])
        expect(
          Exit.isFailure(
            yield* reopened
              .submit(state.binding.id, { ...state.input, callID: "replay" }, secret, root)
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        yield* state.deps.storage.create(key, { ...value, hash: "b".repeat(64) })
        expect(
          yield* reopened.get(state.binding.id, state.input.callID, state.binding.generation, secret, root),
        ).toEqual(call)
        expect(yield* state.deps.storage.list(["raya_openai_voice"])).toEqual([])
        expect(state.calls).toHaveLength(1)
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
  "cascades retained voice data, rejects late replacement, and removes orphan legacy data",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const state = yield* fixture(root)
        const value = yield* retained(state.binding.id)
        const key = ["raya_openai_voice", state.binding.id]
        const db = state.deps.database.db
        const store = Store.make(state.deps.database, state.deps.storage)
        yield* state.deps.storage.create(key, value)
        yield* db.delete(SessionTable).where(eq(SessionTable.id, session)).run().pipe(Effect.orDie)
        expect(yield* db.select().from(Table).pipe(Effect.orDie)).toEqual([])
        expect(Exit.isFailure(yield* store.replace(value).pipe(Effect.exit))).toBe(true)
        expect(
          Exit.isFailure(
            yield* state.voice.close(state.binding.id, state.binding.generation, secret, root).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(yield* state.deps.storage.list(["raya_openai_voice"])).toEqual([])
        expect(yield* db.select().from(Table).pipe(Effect.orDie)).toEqual([])
        expect(state.calls).toHaveLength(0)
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
  "a failed legacy SQL insert preserves valid data and cannot create an owner",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const state = yield* fixture(root)
        const value = yield* retained(state.binding.id)
        const db = state.deps.database.db
        yield* state.deps.storage.create(["raya_openai_voice", state.binding.id], value)
        yield* db.delete(Table).where(eq(Table.id, state.binding.id)).run().pipe(Effect.orDie)
        // An actual SQLite trigger places deletion precisely after the adapter's parent lookup.
        yield* db
          .run(
            sql`CREATE TRIGGER delete_voice_parent BEFORE INSERT ON raya_voice_binding BEGIN DELETE FROM session WHERE id = NEW.session_id; END`,
          )
          .pipe(Effect.orDie)
        const result = yield* Store.make(state.deps.database, state.deps.storage)
          .read(state.binding.id)
          .pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        expect(yield* db.select().from(Table).pipe(Effect.orDie)).toEqual([])
        // SQLite rolls back the trigger's delete with the failed insert: retain the valid legacy record for repair.
        expect(yield* state.deps.storage.read(["raya_openai_voice", state.binding.id])).toEqual(value)
        expect(state.calls).toHaveLength(0)
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
  "a late admitted prompt result cannot recreate its deleted parent binding",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const scope = yield* Scope.make()
        const state = yield* fixture(root, (input) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            return answer(input)
          }),
        ).pipe(Effect.provideService(Scope.Scope, scope))
        yield* state.voice.submit(state.binding.id, state.input, secret, root)
        yield* Deferred.await(entered)
        const saved = yield* retained(state.binding.id)
        const db = state.deps.database.db
        yield* db.delete(SessionTable).where(eq(SessionTable.id, session)).run().pipe(Effect.orDie)
        yield* Deferred.succeed(release, undefined)
        for (const _ of Array.from({ length: 200 })) {
          if (!state.runner.busy) break
          yield* Effect.sleep("10 millis")
        }
        expect(state.runner.busy).toBe(false)
        yield* Effect.sleep("50 millis")
        yield* Scope.close(scope, Exit.succeed(undefined))
        expect(
          Exit.isFailure(yield* Store.make(state.deps.database, state.deps.storage).replace(saved).pipe(Effect.exit)),
        ).toBe(true)
        expect(yield* db.select().from(Table).pipe(Effect.orDie)).toEqual([])
        expect(yield* state.deps.storage.list(["raya_openai_voice"])).toEqual([])
        expect(state.calls).toHaveLength(1)
      }).pipe(
        Effect.provide([
          Storage.layerFromDir(path.join(root, "storage")),
          Database.layerFromPath(path.join(root, "voice.sqlite")),
        ]),
      )
    }),
  30_000,
)
