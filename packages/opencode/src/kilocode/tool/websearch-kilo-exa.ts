// kilocode_change - new file
import { Cause, Duration, Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { KILO_API_BASE } from "@kilocode/kilo-gateway"
import { createHash } from "node:crypto"
import type { RayaGoal } from "@/kilocode/goal"
import type * as Tool from "@/tool/tool"
import * as Log from "@opencode-ai/core/util/log"

export const KILO_EXA_URL = `${KILO_API_BASE}/api/exa/search`
export const MAX_KILO_EXA_RESULTS = 10

const ExaResult = Schema.Struct({
  title: Schema.optional(Schema.String),
  url: Schema.String,
  publishedDate: Schema.optional(Schema.String),
  author: Schema.optional(Schema.String),
  highlights: Schema.optional(Schema.Array(Schema.String)),
})

const ExaResponse = Schema.Struct({
  results: Schema.Array(ExaResult),
  requestId: Schema.optional(Schema.Unknown),
  costDollars: Schema.optional(Schema.Unknown),
})

type Billing = { id?: string; amount?: number; reason?: string }

type Lease = {
  dispatch: Effect.Effect<void, unknown>
  release: Effect.Effect<void>
  settle: (charge: RayaGoal.Charge) => Effect.Effect<void, unknown>
}

const NO_RESULTS = "No search results found. Please try a different query."
const log = Log.create({ service: "websearch" })

const formatResults = (data: Schema.Schema.Type<typeof ExaResponse>): string => {
  if (data.results.length === 0) return NO_RESULTS
  return data.results
    .map((r, i) => {
      const head = `[${i + 1}] ${r.title ?? r.url}\n${r.url}${r.publishedDate ? ` (${r.publishedDate})` : ""}`
      const hl = r.highlights?.length ? `\n${r.highlights.map((h) => `> ${h}`).join("\n")}` : ""
      return `${head}${hl}`
    })
    .join("\n\n")
}

const billing = (data: Schema.Schema.Type<typeof ExaResponse>): Billing => {
  const id =
    typeof data.requestId === "string" && data.requestId.length > 0 && data.requestId.length <= 256
      ? data.requestId
      : undefined
  const cost =
    data.costDollars && typeof data.costDollars === "object" && !Array.isArray(data.costDollars)
      ? "total" in data.costDollars
        ? data.costDollars.total
        : undefined
      : undefined
  if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0 && cost <= 1_000_000) return { id, amount: cost }
  return {
    id,
    reason:
      cost === undefined
        ? "Kilo Exa completed the search without reporting its billed amount."
        : "Kilo Exa returned an invalid billed amount for the completed search.",
  }
}

export function webSearchCharge(input: {
  billing: Billing
  sessionID: Tool.Context["sessionID"]
  messageID: Tool.Context["messageID"]
  callID?: string
  at: number
}): RayaGoal.Charge {
  const identity = JSON.stringify([
    input.billing.id ?? null,
    input.sessionID,
    input.messageID,
    input.callID ?? "unknown",
  ])
  const base = {
    id: `websearch:kilo-exa:${createHash("sha256").update(identity).digest("hex")}`,
    kind: "tool" as const,
    provider: "Kilo",
    service: "Exa Web Search",
    source: "kilo-exa.costDollars.total",
    origin: {
      sessionID: input.sessionID,
      messageID: input.messageID,
      ...(input.callID ? { callID: input.callID } : {}),
    },
    at: input.at,
  }
  if (input.billing.amount !== undefined)
    return { ...base, coverage: "recorded", amount: input.billing.amount, currency: "USD" }
  return {
    ...base,
    coverage: "unknown",
    currency: "USD",
    reason: input.billing.reason ?? "Kilo Exa did not report a billed amount for the completed search.",
  }
}

export type KiloExaParams = {
  query: string
  type?: string
  numResults?: number
}

export const callKiloExa = Effect.fn("WebSearchKiloExa.call")(function* (
  http: HttpClient.HttpClient,
  params: KiloExaParams,
  kiloToken: string,
) {
  const numResults = Math.min(params.numResults ?? MAX_KILO_EXA_RESULTS, MAX_KILO_EXA_RESULTS)
  const request = yield* HttpClientRequest.post(KILO_EXA_URL).pipe(
    HttpClientRequest.bearerToken(kiloToken),
    HttpClientRequest.acceptJson,
    HttpClientRequest.bodyJson({
      query: params.query,
      type: params.type ?? "auto",
      numResults,
      contents: { highlights: true },
    }),
  )
  const response = yield* http.execute(request).pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(25),
      orElse: () => Effect.die(new Error("kilo exa request timed out")),
    }),
  )
  const status = response.status
  if (status === 401 || status === 403) {
    return yield* Effect.die(new Error(`Kilo exa request unauthorized (${status}); sign in with \`kilo auth login\``))
  }
  if (status < 200 || status >= 300) {
    const body = yield* response.text
    return yield* Effect.die(new Error(`Kilo exa request failed (${status}): ${body.slice(0, 200)}`))
  }
  const data = yield* response.json
  const decode = Schema.decodeUnknownEffect(ExaResponse)
  const parsed = yield* decode(data).pipe(Effect.orDie)
  return { output: formatResults(parsed), billing: billing(parsed) }
})

export const executeKiloExa = Effect.fn("WebSearchKiloExa.execute")(function* (input: {
  http: HttpClient.HttpClient
  params: KiloExaParams
  token: string
  lease: Lease
  sessionID: Tool.Context["sessionID"]
  messageID: Tool.Context["messageID"]
  callID?: string
  at: number
}) {
  yield* input.lease.dispatch.pipe(Effect.onError(() => input.lease.release))
  const result = yield* callKiloExa(input.http, input.params, input.token)
  const charge = webSearchCharge({
    billing: result.billing,
    sessionID: input.sessionID,
    messageID: input.messageID,
    callID: input.callID,
    at: input.at,
  })
  yield* input.lease.settle(charge).pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() =>
        log.warn("hosted search charge settlement deferred to turn accounting", {
          cause: Cause.squash(cause),
        }),
      ),
    ),
  )
  yield* input.lease.release
  return { ...result, charge }
})

export const admitKiloExa = Effect.fn("WebSearchKiloExa.admit")(function* (input: {
  http: HttpClient.HttpClient
  params: KiloExaParams
  token: string
  claim: Effect.Effect<Lease, unknown>
  sessionID: Tool.Context["sessionID"]
  messageID: Tool.Context["messageID"]
  callID?: string
  at: number
}) {
  const lease = yield* input.claim
  return yield* executeKiloExa({ ...input, lease })
})
