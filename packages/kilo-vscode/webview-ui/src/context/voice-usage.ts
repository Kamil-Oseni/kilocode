import { createSignal } from "solid-js"
import type { VoiceUsage } from "../../../src/shared/voice-usage"
import type { ExtensionMessage } from "../types/messages"

export function createVoiceUsage(session: () => string | undefined) {
  const [owner, setOwner] = createSignal<{ id: string; session: string }>()
  const [value, setValue] = createSignal<VoiceUsage>()
  return {
    state: () => (owner()?.session === session() ? value() : undefined),
    bind(id: string, session: string) {
      setOwner({ id, session })
      setValue(undefined)
    },
    receive(message: ExtensionMessage) {
      if (message.type !== "speechOpenAIUsage") return false
      if (
        owner()?.id !== message.requestId ||
        owner()?.session !== message.sessionID ||
        session() !== message.sessionID
      )
        return true
      const value = message.usage
      if (!value || typeof value.incomplete !== "boolean") return true
      const keys = [
        "responses",
        "transcriptions",
        "input",
        "output",
        "missing",
        "invalid",
        "recorded",
        "unrecorded",
        "pending",
      ] as const
      if (keys.some((key) => !Number.isSafeInteger(value[key]) || value[key] < 0)) return true
      if (
        value.seconds !== undefined &&
        (!Number.isFinite(value.seconds) || value.seconds < 0 || value.seconds > 512 * 86400)
      )
        return true
      if (
        value.durations !== undefined &&
        (!Number.isSafeInteger(value.durations) || value.durations < 0 || value.durations > 512)
      )
        return true
      setValue({ ...value })
      return true
    },
  }
}
