import type { SpeechService } from "../speech/service"
import { event } from "../shared/voice-handoff"
import type { Handoff, HandoffEvent } from "../shared/voice-handoff"

type Speech = Pick<
  SpeechService,
  | "openaiState"
  | "openaiPrepare"
  | "openaiPrepared"
  | "openaiQuiesce"
  | "openaiCommit"
  | "openaiCutover"
  | "openaiRetire"
  | "openaiCancel"
>

type Context = {
  speech?: Speech
  post: (message: unknown) => void
  voiceScope?: (sessionID: string) => { directory: string; current: () => boolean } | undefined
}

/** The renderer supplies media evidence, never backend or provider authority. */
export async function route(message: unknown, ctx: Context): Promise<boolean> {
  if (!message || typeof message !== "object" || !("type" in message)) return false
  if (typeof message.type !== "string" || !message.type.startsWith("speechOpenAIHandoff")) return false
  if (!event(message) || !ctx.speech) return true
  const handoff = identity(message)
  const scope = ctx.voiceScope?.(handoff.sessionID)
  if (!scope?.current()) return true
  const post = (message: unknown) => {
    if (scope.current()) ctx.post(message)
  }
  if (!accept(message, handoff, ctx.speech)) return true
  try {
    await execute(message, handoff, ctx.speech, post)
  } catch (err) {
    // Only the broker can prove that pre-commit cancellation may restore the source.
    const result = await ctx.speech.openaiCancel(handoff).catch(() => ({ restore: false }))
    post({ type: "speechOpenAIHandoffCancel", handoff, restore: result.restore })
    console.warn("[Raya] Voice handoff could not be completed:", err instanceof Error ? err.name : "unknown")
  }
  return true
}

const phases = new Map([
  ["speechOpenAIHandoffPrepared", "preparing"],
  ["speechOpenAIHandoffQuiesced", "prepared"],
  ["speechOpenAIHandoffCutoverAck", "committed"],
  ["speechOpenAIHandoffRetired", "cutover"],
])

function accept(message: HandoffEvent, handoff: Handoff, speech: Speech) {
  try {
    const state = speech.openaiState(handoff)
    if (message.type === "speechOpenAIHandoffOffer" || state.phase === "retired") return false
    const phase = phases.get(message.type)
    return phase === undefined || state.phase === phase
  } catch {
    // Only a new offer can establish ownership; stale acknowledgements cannot revive it.
    return message.type === "speechOpenAIHandoffOffer"
  }
}

async function execute(message: HandoffEvent, handoff: Handoff, speech: Speech, post: Context["post"]) {
  switch (message.type) {
    case "speechOpenAIHandoffOffer":
      await speech.openaiPrepare(handoff, message.sdp, post)
      return
    case "speechOpenAIHandoffPrepared":
      await speech.openaiPrepared(handoff)
      post({ type: "speechOpenAIHandoffQuiesce", handoff })
      return
    case "speechOpenAIHandoffQuiesced":
      await speech.openaiQuiesce(message.quiet)
      await speech.openaiCommit(handoff)
      post({ type: "speechOpenAIHandoffCutover", quiet: message.quiet })
      return
    case "speechOpenAIHandoffCutoverAck":
      await speech.openaiCutover(handoff)
      post({ type: "speechOpenAIHandoffRetire", handoff })
      return
    case "speechOpenAIHandoffRetired":
      await speech.openaiRetire(handoff, message.confirmed)
      return
    case "speechOpenAIHandoffCancel": {
      const result = await speech.openaiCancel(handoff)
      post({ type: "speechOpenAIHandoffCancel", handoff, restore: result.restore })
      return
    }
  }
}

function identity(message: HandoffEvent): Handoff {
  const item = "handoff" in message ? message.handoff : "ack" in message ? message.ack : message.quiet
  return { version: 1, id: item.id, sessionID: item.sessionID, source: item.source, target: item.target }
}
