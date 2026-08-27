// raya_change - Realtime voice HTTP handlers backed by the existing Kilo session runtime.
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { Storage } from "@/storage/storage"
import { RayaVoice } from "@/kilocode/voice/service"
import { Envelope, Start, type VoiceSessionID } from "@/kilocode/voice/protocol"

export const voiceHandlers = HttpApiBuilder.group(InstanceHttpApi, "raya-voice", (handlers) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const prompts = yield* SessionPrompt.Service
    const storage = yield* Storage.Service
    const voice = RayaVoice.make({ sessions, prompts, storage })

    return handlers
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
