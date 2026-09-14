// raya_change - Realtime voice HTTP handlers backed by the existing Kilo session runtime.
import { Database } from "@opencode-ai/core/database/database"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { Storage } from "@/storage/storage"
import { RayaVoice } from "@/kilocode/voice/service"
import { Envelope, Start, type VoiceSessionID } from "@/kilocode/voice/protocol"
import * as OpenAIVoice from "@/kilocode/voice/openai"
import { pricing as livePricing } from "@/kilocode/voice/live-protocol"
import * as TaskWorker from "@/kilocode/session/task-worker"
import { InstanceState } from "@/effect/instance-state"
import { RayaGoal } from "@/kilocode/goal"
import * as GoalCharges from "@/kilocode/goal/charges"

const failure = (error: OpenAIVoice.VoiceError) => {
  if (error.code === "unauthorized") return new HttpApiError.Unauthorized({})
  if (error.code === "missing") return new HttpApiError.NotFound({})
  if (error.code === "invalid") return new HttpApiError.BadRequest({})
  return new HttpApiError.Conflict({})
}

export const voiceHandlers = HttpApiBuilder.group(InstanceHttpApi, "raya-voice", (handlers) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const prompts = yield* SessionPrompt.Service
    const storage = yield* Storage.Service
    const voice = RayaVoice.make({ sessions, prompts, storage })
    const workers = yield* TaskWorker.Service
    const database = yield* Database.Service
    const goals = RayaGoal.make({ sessions, storage })
    const reservations = yield* GoalCharges.make({ sessions, storage })
    const openai = yield* OpenAIVoice.make({
      sessions,
      prompts,
      storage,
      workers,
      database,
      admissions: (sessionID, identity) =>
        reservations.claim(sessionID, "USD", identity).pipe(
          Effect.map((lease) => ({
            dispatch: lease.dispatch.pipe(
              Effect.mapError((error) => new OpenAIVoice.VoiceError({ code: "conflict", message: error.message })),
            ),
            finish: lease.finish.pipe(
              Effect.mapError((error) => new OpenAIVoice.VoiceError({ code: "conflict", message: error.message })),
            ),
            release: lease.release,
          })),
          Effect.mapError((error) => new OpenAIVoice.VoiceError({ code: "conflict", message: error.message })),
        ),
      completions: (sessionID, identity) =>
        reservations
          .complete(sessionID, "USD", identity)
          .pipe(Effect.mapError((error) => new OpenAIVoice.VoiceError({ code: "conflict", message: error.message }))),
      charges: (input) => {
        const price = livePricing({ id: input.id, model: "gpt-live-1", seconds: input.seconds })
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
          .pipe(
            Effect.asVoid,
            Effect.catchTag("RayaGoal.NotFoundError", () => Effect.void),
            Effect.mapError((error) => new OpenAIVoice.VoiceError({ code: "conflict", message: error.message })),
          )
      },
      usageCharges: (input) => {
        const price = input.pricing
        const receipt =
          price.coverage === "recorded"
            ? ({
                id: input.id,
                kind: "gpt-live" as const,
                provider: "OpenAI",
                service: input.model,
                source: price.source,
                origin: { sessionID: input.sessionID, callID: input.callID },
                at: input.at,
                quantity: price.quantity,
                unit: price.unit,
                coverage: "recorded" as const,
                amount: price.amount,
                currency: price.currency,
              } satisfies RayaGoal.Charge)
            : ({
                id: input.id,
                kind: "gpt-live" as const,
                provider: "OpenAI",
                service: input.model,
                source: price.source,
                origin: { sessionID: input.sessionID, callID: input.callID },
                at: input.at,
                ...(price.quantity !== undefined ? { quantity: price.quantity } : {}),
                ...(price.unit !== undefined ? { unit: price.unit } : {}),
                coverage: "unknown" as const,
                currency: "USD",
                reason: price.reason,
              } satisfies RayaGoal.Charge)
        return goals.charged(input.sessionID, receipt).pipe(
          Effect.asVoid,
          Effect.catchTag("RayaGoal.NotFoundError", () => Effect.void),
          Effect.mapError((error) => new OpenAIVoice.VoiceError({ code: "conflict", message: error.message })),
        )
      },
    })
    yield* openai.reconcile().pipe(
      Effect.catch((error) => Effect.logError("Voice usage reconciliation did not start", { error })),
      Effect.forkScoped,
    )

    return handlers
      .handle("voiceLiveCall", (ctx) =>
        Effect.gen(function* () {
          return yield* openai.delegate(
            ctx.params.id,
            ctx.payload,
            ctx.headers["x-raya-voice-key"] ?? "",
            yield* InstanceState.directory,
          )
        }).pipe(
          Effect.catchTag("VoiceError", (error) => Effect.fail(failure(error))),
          Effect.catchTag("NotFoundError", () => Effect.fail(new HttpApiError.NotFound({}))),
        ),
      )
      .handle("voiceLiveDuration", (ctx) =>
        Effect.gen(function* () {
          return yield* openai.duration(
            ctx.params.id,
            ctx.payload,
            ctx.headers["x-raya-voice-key"] ?? "",
            yield* InstanceState.directory,
          )
        }).pipe(Effect.catchTag("VoiceError", (error) => Effect.fail(failure(error)))),
      )
      .handle("voiceOpenAIStart", (ctx) =>
        Effect.gen(function* () {
          return yield* openai.start(ctx.payload, ctx.headers["x-raya-voice-key"] ?? "", yield* InstanceState.directory)
        }).pipe(
          Effect.catchTag("VoiceError", (error) => Effect.fail(failure(error))),
          Effect.catchTag("NotFoundError", () => Effect.fail(new HttpApiError.NotFound({}))),
        ),
      )
      .handle("voiceOpenAIReserve", (ctx) =>
        Effect.gen(function* () {
          return yield* openai.reserve(
            ctx.payload,
            ctx.headers["x-raya-voice-key"] ?? "",
            yield* InstanceState.directory,
          )
        }).pipe(
          Effect.catchTag("VoiceError", (error) => Effect.fail(failure(error))),
          Effect.catchTag("NotFoundError", () => Effect.fail(new HttpApiError.NotFound({}))),
        ),
      )
      .handle("voiceOpenAIRelease", (ctx) =>
        Effect.gen(function* () {
          return yield* openai.release(
            ctx.payload,
            ctx.headers["x-raya-voice-key"] ?? "",
            yield* InstanceState.directory,
          )
        }).pipe(
          Effect.catchTag("VoiceError", (error) => Effect.fail(failure(error))),
          Effect.catchTag("NotFoundError", () => Effect.fail(new HttpApiError.NotFound({}))),
        ),
      )
      .handle("voiceOpenAIMeter", (ctx) =>
        Effect.gen(function* () {
          return yield* openai.meter(
            ctx.params.id,
            ctx.payload,
            ctx.headers["x-raya-voice-key"] ?? "",
            yield* InstanceState.directory,
          )
        }).pipe(Effect.catchTag("VoiceError", (error) => Effect.fail(failure(error)))),
      )
      .handle("voiceOpenAIUsage", (ctx) =>
        Effect.gen(function* () {
          return yield* openai.usage(
            ctx.params.id,
            ctx.query.generation,
            ctx.headers["x-raya-voice-key"] ?? "",
            yield* InstanceState.directory,
          )
        }).pipe(Effect.catchTag("VoiceError", (error) => Effect.fail(failure(error)))),
      )
      .handle("voiceOpenAIImage", (ctx) =>
        Effect.gen(function* () {
          return yield* openai.stage(
            ctx.params.id,
            ctx.payload,
            ctx.headers["x-raya-voice-key"] ?? "",
            yield* InstanceState.directory,
          )
        }).pipe(
          Effect.catchTag("VoiceError", (error) => Effect.fail(failure(error))),
          Effect.catchTag("NotFoundError", () => Effect.fail(new HttpApiError.NotFound({}))),
        ),
      )
      .handle("voiceOpenAICall", (ctx) =>
        Effect.gen(function* () {
          return yield* openai.submit(
            ctx.params.id,
            ctx.payload,
            ctx.headers["x-raya-voice-key"] ?? "",
            yield* InstanceState.directory,
          )
        }).pipe(
          Effect.catchTag("VoiceError", (error) => Effect.fail(failure(error))),
          Effect.catchTag("NotFoundError", () => Effect.fail(new HttpApiError.NotFound({}))),
        ),
      )
      .handle("voiceOpenAIResult", (ctx) =>
        Effect.gen(function* () {
          return yield* openai.get(
            ctx.params.id,
            ctx.params.callID,
            ctx.query.generation,
            ctx.headers["x-raya-voice-key"] ?? "",
            yield* InstanceState.directory,
          )
        }).pipe(Effect.catchTag("VoiceError", (error) => Effect.fail(failure(error)))),
      )
      .handle("voiceOpenAICancel", (ctx) =>
        Effect.gen(function* () {
          return yield* openai.cancel(
            ctx.params.id,
            ctx.params.callID,
            ctx.payload.generation,
            ctx.headers["x-raya-voice-key"] ?? "",
            yield* InstanceState.directory,
          )
        }).pipe(Effect.catchTag("VoiceError", (error) => Effect.fail(failure(error)))),
      )
      .handle("voiceOpenAIClose", (ctx) =>
        Effect.gen(function* () {
          return yield* openai.close(
            ctx.params.id,
            ctx.query.generation,
            ctx.headers["x-raya-voice-key"] ?? "",
            yield* InstanceState.directory,
          )
        }).pipe(Effect.catchTag("VoiceError", (error) => Effect.fail(failure(error)))),
      )
      .handle("voiceStart", (ctx: { headers: { "x-raya-media-key": string }; payload: typeof Start.Type }) =>
        voice.start(ctx.payload, ctx.headers["x-raya-media-key"]).pipe(
          Effect.catchTag("NotFoundError", () => Effect.fail(new HttpApiError.NotFound({}))),
          Effect.catchTag("RayaVoice.InputError", () => Effect.fail(new HttpApiError.BadRequest({}))),
        ),
      )
      .handle("voiceState", (ctx: { params: { voiceSessionID: VoiceSessionID } }) =>
        voice
          .get(ctx.params.voiceSessionID)
          .pipe(
            Effect.flatMap((state) => (state ? Effect.succeed(state) : Effect.fail(new HttpApiError.NotFound({})))),
          ),
      )
      .handle("voiceEvent", (ctx: { payload: typeof Envelope.Type }) =>
        voice
          .event(ctx.payload)
          .pipe(
            Effect.flatMap((accepted) =>
              accepted ? Effect.succeed(true) : Effect.fail(new HttpApiError.NotFound({})),
            ),
          ),
      )
      .handle("voiceClose", (ctx: { params: { voiceSessionID: VoiceSessionID } }) =>
        voice
          .close(ctx.params.voiceSessionID)
          .pipe(
            Effect.flatMap((closed) => (closed ? Effect.succeed(true) : Effect.fail(new HttpApiError.NotFound({})))),
          ),
      )
  }),
)
