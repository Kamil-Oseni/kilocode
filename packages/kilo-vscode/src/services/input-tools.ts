import type { KiloConnectionService } from "./cli-backend/connection-service"
import { routeAutocompleteMessage } from "./autocomplete/settings"
import { handleSpeechToTextCancel, handleSpeechToTextStart, handleSpeechToTextStop } from "../speech-to-text/handler"
import { prewarmSpeechCapture } from "../speech-to-text/capture"
import type { SpeechService } from "../speech/service" // raya_change - Milestone H configured speech service
import type { SpeechSettings } from "../speech/settings" // raya_change - Milestone H

type Msg = {
  type: string
  requestId?: string
  model?: string
  language?: string
  data?: string // raya_change - Milestone H webview microphone capture
  format?: string // raya_change - Milestone H webview microphone capture
  text?: string // raya_change - Milestone H TTS
  settings?: SpeechSettings // raya_change - Milestone H settings
  kind?: "realtime" | "stt" | "tts" // raya_change - Milestone H and native realtime secret keys
  key?: string // raya_change - Milestone H secret keys
  handsFree?: boolean // raya_change - Milestone H extension-host VAD fallback
  threshold?: number // raya_change - Milestone H extension-host VAD fallback
  silenceMs?: number // raya_change - Milestone H extension-host VAD fallback
  sessionID?: string // raya_change - realtime voice parent session
}

type Ctx = {
  connection: KiloConnectionService
  dir: string
  post: (msg: unknown) => void
  speech?: SpeechService // raya_change - Milestone H
}

export async function routeInputToolMessage(message: Msg, ctx: Ctx): Promise<boolean> {
  if (await routeAutocompleteMessage(message, ctx.post)) return true

  if (await routeSpeechMessage(message, ctx)) return true // raya_change - Milestone H

  if (message.type === "speechToTextPrewarm") {
    void prewarmSpeechCapture().catch((err: unknown) => console.warn("[Kilo New] Speech capture prewarm failed:", err))
    return true
  }

  if (message.type === "speechToTextStart") {
    if (!message.requestId) return true
    if (ctx.speech && (await ctx.speech.configured())) {
      await ctx.speech.captureStart(
        {
          requestId: message.requestId,
          model: message.model,
          language: message.language,
          handsFree: message.handsFree,
          threshold: message.threshold,
          silenceMs: message.silenceMs,
        },
        ctx.post,
      )
      return true
    }
    handleSpeechToTextStart(
      { requestId: message.requestId, model: message.model, language: message.language },
      ctx.post,
    )
    return true
  }

  if (message.type === "speechToTextStop") {
    if (!message.requestId) return true
    if (ctx.speech && (await ctx.speech.configured())) {
      await ctx.speech.captureStop({ requestId: message.requestId, language: message.language }, ctx.post)
      return true
    }
    handleSpeechToTextStop(ctx.connection, { requestId: message.requestId }, ctx.dir, ctx.post)
    return true
  }

  if (message.type === "speechToTextCancel") {
    if (!message.requestId) return true
    if (ctx.speech && (await ctx.speech.configured())) {
      ctx.speech.captureCancel(message.requestId, ctx.post)
      return true
    }
    handleSpeechToTextCancel({ requestId: message.requestId }, ctx.post)
    return true
  }

  return false
}

// raya_change start - Milestone H configured STT, streaming TTS, and settings lifecycle
async function routeSpeechMessage(message: Msg, ctx: Ctx): Promise<boolean> {
  if (routeSpeechPlayback(message, ctx)) return true
  if (message.type === "speechSettingsRequest") {
    await ctx.speech?.state(ctx.post)
    return true
  }
  if (message.type === "speechSettingsUpdate") {
    if (message.settings) await ctx.speech?.update(message.settings, ctx.dir, ctx.post)
    return true
  }
  if (message.type === "speechKeyUpdate") {
    if (message.kind) await ctx.speech?.key(message.kind, message.key, ctx.dir, ctx.post)
    return true
  }
  if (message.type === "speechRealtimeStart") {
    if (message.sessionID)
      await ctx.speech?.realtimeStart(
        { sessionID: message.sessionID, directory: ctx.dir, connection: ctx.connection },
        ctx.post,
      )
    return true
  }
  if (message.type === "speechRealtimeStop") {
    await ctx.speech?.realtimeStop(ctx.post)
    return true
  }
  if (message.type === "speechToTextSubmit") {
    if (ctx.speech && message.requestId && message.data && message.format)
      await ctx.speech.transcribe(
        {
          requestId: message.requestId,
          data: message.data,
          format: message.format,
          model: message.model,
          language: message.language,
        },
        ctx.post,
      )
    return true
  }
  return false
}

function routeSpeechPlayback(message: Msg, ctx: Ctx) {
  if (message.type === "speechVoiceTurn") {
    ctx.speech?.markVoiceTurn()
    return true
  }
  if (message.type === "speechPlaybackStart") {
    if (ctx.speech && message.requestId && message.text)
      void ctx.speech.speak({ requestId: message.requestId, text: message.text }, ctx.post)
    return true
  }
  if (message.type !== "speechPlaybackCancel") return false
  ctx.speech?.cancel(message.requestId)
  return true
}
// raya_change end
