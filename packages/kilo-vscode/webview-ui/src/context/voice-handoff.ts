import {
  valid,
  quiet,
  same,
  command,
  type Handoff,
  type HandoffQuiet,
  type HandoffEvent,
} from "../../../src/shared/voice-handoff"
import type { ExtensionMessage } from "../types/messages"
import type { OpenAIVoice } from "./openai-voice"

type Owner = { id: string; session: string; engine: "live" | "realtime" }
type State = {
  handoff: Handoff
  epoch: number
  phase: "preparing" | "prepared" | "quiesced" | "cutover" | "retired" | "failed"
  quiet?: HandoffQuiet
  promoted?: boolean
  pending?: { resolve: (sdp: string) => void; reject: (error: Error) => void }
}

/** Local media acknowledgements only. Provider configuration and authority stay on the host. */
export function createHandoff(input: {
  media: OpenAIVoice
  current: () => Owner | undefined
  session: () => string | undefined
  generation: () => number
  busy: () => boolean
  post: (event: HandoffEvent) => void
  switched: (handoff: Handoff) => void
  ended: () => void
}) {
  let state: State | undefined
  const owned = (record: State) => {
    const owner = input.current()
    return (
      state === record &&
      input.generation() === record.epoch &&
      input.session() === record.handoff.sessionID &&
      owner?.session === record.handoff.sessionID &&
      owner.engine === "realtime" &&
      owner.id === (record.promoted ? record.handoff.target : record.handoff.source)
    )
  }
  const cancel = (record: State, reason: Extract<HandoffEvent, { type: "speechOpenAIHandoffCancel" }>["reason"]) => {
    if (state !== record || record.phase === "failed") return
    record.phase = "failed"
    input.post({ type: "speechOpenAIHandoffCancel", handoff: record.handoff, reason })
  }
  const prepare = async (record: State) => {
    try {
      const ack = await input.media.prepare(
        record.handoff,
        (sdp) =>
          new Promise<string>((resolve, reject) => {
            if (!owned(record)) return reject(new Error("Voice replacement ownership changed."))
            record.pending = { resolve, reject }
            input.post({ type: "speechOpenAIHandoffOffer", handoff: record.handoff, sdp })
          }),
      )
      if (!owned(record)) return
      record.phase = "prepared"
      input.post({ type: "speechOpenAIHandoffPrepared", ack })
    } catch {
      if (owned(record)) cancel(record, "unavailable")
    }
  }
  const begin = (handoff: Handoff) => {
    if (
      !valid(handoff) ||
      (state && state.phase !== "retired") ||
      input.current()?.id !== handoff.source ||
      input.current()?.engine !== "realtime" ||
      input.session() !== handoff.sessionID ||
      input.current()?.session !== handoff.sessionID
    )
      return
    const record: State = { handoff: Object.freeze({ ...handoff }), epoch: input.generation(), phase: "preparing" }
    state = record
    void prepare(record)
  }
  const switcher = (record: State, token: HandoffQuiet) => {
    if (
      !quiet(token) ||
      !same(record.handoff, token) ||
      !record.quiet ||
      record.quiet.epoch !== token.epoch ||
      !["quiesced", "cutover", "retired"].includes(record.phase)
    )
      return
    try {
      const ack = input.media.cutover(token)
      if (!record.promoted) {
        record.phase = "cutover"
        record.promoted = true
        input.switched(record.handoff)
      }
      input.post({ type: "speechOpenAIHandoffCutoverAck", ack })
    } catch {
      cancel(record, "activity")
      input.ended()
    }
  }
  const answer = (record: State, sdp: string) => {
    if (record.phase !== "preparing" || !record.pending || !sdp || sdp.length > 262_144) return
    const waiting = record.pending
    record.pending = undefined
    waiting.resolve(sdp)
  }
  const quiesce = (record: State) => {
    if (!["prepared", "quiesced"].includes(record.phase)) return
    try {
      if (input.busy()) throw new Error("Voice controls are pending.")
      record.quiet = input.media.quiesce(record.handoff)
      record.phase = "quiesced"
      input.post({ type: "speechOpenAIHandoffQuiesced", quiet: record.quiet })
    } catch {
      cancel(record, "activity")
    }
  }
  const retire = (record: State) => {
    if (!["cutover", "retired"].includes(record.phase)) return
    const confirmed = input.media.retire(record.handoff.source)
    if (confirmed) record.phase = "retired"
    input.post({ type: "speechOpenAIHandoffRetired", handoff: record.handoff, confirmed })
    if (!confirmed) input.ended()
  }
  const restore = (record: State, value: boolean) => {
    if (value && record.promoted) return input.ended()
    record.pending?.reject(new Error("Voice replacement cancelled."))
    record.pending = undefined
    void input.media.cancel(record.handoff, value).then(
      (confirmed) => {
        if (state !== record) return
        state = undefined
        if (!confirmed || !value) input.ended()
      },
      () => {
        if (state !== record) return
        state = undefined
        input.ended()
      },
    )
  }
  return {
    close() {
      const record = state
      state = undefined
      record?.pending?.reject(new Error("Voice replacement cancelled."))
      if (record && record.phase !== "retired")
        input.post({ type: "speechOpenAIHandoffCancel", handoff: record.handoff, reason: "cancelled" })
    },
    receive(message: ExtensionMessage) {
      if (!message.type.startsWith("speechOpenAIHandoff")) return false
      if (!command(message)) return true
      if (message.type === "speechOpenAIHandoffPrepare") {
        begin(message.handoff)
        return true
      }
      const record = state
      if (!record || !owned(record)) return true
      if (message.type === "speechOpenAIHandoffCutover") {
        switcher(record, message.quiet)
        return true
      }
      if (!same(record.handoff, message.handoff)) return true
      switch (message.type) {
        case "speechOpenAIHandoffAnswer":
          answer(record, message.sdp)
          break
        case "speechOpenAIHandoffQuiesce":
          quiesce(record)
          break
        case "speechOpenAIHandoffRetire":
          retire(record)
          break
        case "speechOpenAIHandoffCancel":
          restore(record, message.restore)
          break
        case "speechOpenAIHandoffNotice": {
          if (record.promoted) {
            input.ended()
            break
          }
          const confirmed = input.media.discard(record.handoff)
          cancel(record, confirmed ? message.reason : "cleanup")
          break
        }
      }
      return true
    },
  }
}
