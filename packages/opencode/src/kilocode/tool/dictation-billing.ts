import { createHash } from "node:crypto"
import { Effect } from "effect"

type Identity = { ok: true; value?: string } | { ok: false; value?: never }

type Input = {
  requestID?: string
  sessionID?: string
  model: string
  input_audio: { data: string; format: string }
  language?: string
  prompt?: string
  temperature?: number
}

export type Lease = {
  dispatch: Effect.Effect<void, Error>
  finish: Effect.Effect<void, Error>
  release: Effect.Effect<void>
  uncertain: (reason: string) => Effect.Effect<void, Error>
}

export function identify(session?: string, request?: string): Identity {
  if (Boolean(session) !== Boolean(request)) return { ok: false }
  if (!session || !request) return { ok: true }
  return {
    ok: true,
    value: `dictation:${createHash("sha256").update(`${session}\0${request}`).digest("hex")}`,
  }
}

export function payload(input: Input) {
  return {
    model: input.model,
    input_audio: input.input_audio,
    ...(input.language ? { language: input.language } : {}),
    ...(input.prompt ? { prompt: input.prompt } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
  }
}

export const run = Effect.fn("DictationBilling.run")(function* (
  lease: Lease | undefined,
  send: Effect.Effect<Response, Error>,
) {
  return yield* Effect.gen(function* () {
    if (lease) yield* lease.dispatch
    const response = yield* send
    const text = yield* Effect.promise(() => response.text())
    const refused =
      response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 499
    if (refused && lease) yield* lease.finish
    if (response.ok && lease)
      yield* lease.uncertain("Raya Gateway completed the transcription without an authoritative monetary receipt.")
    return { response, text }
  }).pipe(Effect.ensuring(lease?.release ?? Effect.void))
})
