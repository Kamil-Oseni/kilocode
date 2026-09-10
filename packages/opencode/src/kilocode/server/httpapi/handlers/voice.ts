// raya_change - Realtime voice HTTP handlers backed by the existing Kilo session runtime.
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { Storage } from "@/storage/storage"
import { RayaVoice } from "@/kilocode/voice/service"
import { Envelope, Start, type VoiceSessionID } from "@/kilocode/voice/protocol"
import * as OpenAIVoice from "@/kilocode/voice/openai"
import * as TaskWorker from "@/kilocode/session/task-worker"
import { InstanceState } from "@/effect/instance-state"

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
    const openai = yield* OpenAIVoice.make({ sessions, prompts, storage, workers })

    return handlers
      .handle("voiceOpenAIStart", (ctx) =>
        Effect.gen(function* () {
          return yield* openai.start(ctx.payload, ctx.headers["x-raya-voice-key"] ?? "", yield* InstanceState.directory)
        }).pipe(
          Effect.catchTag("VoiceError", (error) => Effect.fail(failure(error))),
          Effect.catchTag("NotFoundError", () => Effect.fail(new HttpApiError.NotFound({}))),
        ),
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
      .handle("voiceStart", (ctx: { payload: typeof Start.Type }) =>
        voice
          .start(ctx.payload)
          .pipe(Effect.catchTag("NotFoundError", () => Effect.fail(new HttpApiError.NotFound({})))),
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
