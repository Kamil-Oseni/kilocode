// kilocode_change - new file
import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http"
import {
  KILO_EXA_URL,
  MAX_KILO_EXA_RESULTS,
  type KiloExaParams,
  admitKiloExa,
  callKiloExa,
  executeKiloExa,
  webSearchCharge,
} from "../../../src/kilocode/tool/websearch-kilo-exa"
import { MessageID, SessionID } from "@/session/schema"

type Recorded = {
  url?: string
  method?: string
  authorization?: string
  body?: string
}

const readBody = async (body: HttpBody.HttpBody): Promise<string> => {
  if (body._tag === "Uint8Array") return new TextDecoder().decode(body.body)
  if (body._tag === "Raw") return JSON.stringify(body.body)
  return ""
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

const okJson = (body: unknown) => jsonResponse(200, body)

const fakeHttp = (respond: (status: number) => Response, recorded?: Recorded): HttpClient.HttpClient =>
  HttpClient.make((request) =>
    Effect.gen(function* () {
      const url = request.url
      const method = request.method
      const authorization = request.headers["authorization"]
      const body = yield* Effect.promise(() => readBody(request.body))
      if (recorded) {
        recorded.url = url
        recorded.method = method
        recorded.authorization = authorization
        recorded.body = body
      }
      return HttpClientResponse.fromWeb(
        request as unknown as Parameters<typeof HttpClientResponse.fromWeb>[0],
        respond(200),
      )
    }),
  )

const runCall = async (
  params: KiloExaParams,
  respond: (status: number) => Response,
  recorded?: Recorded,
  kiloToken = "kilo-test-token",
) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const http = fakeHttp(respond, recorded)
      return yield* callKiloExa(http, params, kiloToken)
    }),
  )

describe("callKiloExa request shape", () => {
  test("posts to KILO_EXA_URL with bearer token and highlights-only contents", async () => {
    const recorded: Recorded = {}
    const exit = await runCall({ query: "drone" }, () => okJson({ results: [] }), recorded)
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(recorded.url).toContain("/api/exa/search")
    expect(recorded.method).toBe("POST")
    expect(recorded.authorization).toBe("Bearer kilo-test-token")
    const parsed = JSON.parse(recorded.body!)
    expect(parsed.query).toBe("drone")
    expect(parsed.type).toBe("auto")
    expect(parsed.numResults).toBe(MAX_KILO_EXA_RESULTS)
    expect(parsed.contents).toEqual({ highlights: true })
  })

  test("uses caller numResults when below cap", async () => {
    const recorded: Recorded = {}
    await runCall({ query: "x", numResults: 3 }, () => okJson({ results: [] }), recorded)
    expect(JSON.parse(recorded.body!).numResults).toBe(3)
  })

  test("clamps numResults at MAX_KILO_EXA_RESULTS", async () => {
    const recorded: Recorded = {}
    await runCall({ query: "x", numResults: 25 }, () => okJson({ results: [] }), recorded)
    expect(JSON.parse(recorded.body!).numResults).toBe(MAX_KILO_EXA_RESULTS)
  })

  test("passes through caller type", async () => {
    const recorded: Recorded = {}
    await runCall({ query: "x", type: "deep" }, () => okJson({ results: [] }), recorded)
    expect(JSON.parse(recorded.body!).type).toBe("deep")
  })

  test("KILO_EXA_URL is built from KILO_API_BASE", () => {
    expect(KILO_EXA_URL).toMatch(/\/api\/exa\/search$/)
  })
})

describe("callKiloExa response formatting", () => {
  const okResult = <A, E>(exit: Exit.Exit<A, E>): A => {
    if (Exit.isFailure(exit)) throw new Error("expected success")
    return (exit as Extract<typeof exit, { _tag: "Success" }>).value
  }

  test("formats results with title, url, date and highlights", async () => {
    const exit = await runCall({ query: "x" }, () =>
      okJson({
        results: [
          {
            title: "A drone",
            url: "https://example.com/a",
            publishedDate: "2025-01-02T00:00:00.000Z",
            highlights: ["first", "second"],
          },
        ],
      }),
    )
    const text = okResult(exit).output
    expect(text).toContain("[1] A drone")
    expect(text).toContain("https://example.com/a")
    expect(text).toContain("(2025-01-02T00:00:00.000Z)")
    expect(text).toContain("> first")
    expect(text).toContain("> second")
  })

  test("falls back to url when title is missing", async () => {
    const exit = await runCall({ query: "x" }, () => okJson({ results: [{ url: "https://example.com/no-title" }] }))
    expect(okResult(exit).output).toContain("[1] https://example.com/no-title")
  })

  test("returns NO_RESULTS message on empty results", async () => {
    const exit = await runCall({ query: "x" }, () => okJson({ results: [] }))
    expect(okResult(exit).output).toBe("No search results found. Please try a different query.")
  })

  test("retains authoritative costDollars and request identity", async () => {
    const exit = await runCall({ query: "x" }, () =>
      okJson({
        results: [{ url: "https://example.com" }],
        costDollars: { total: 0.007, search: { neural: 0.007 } },
        requestId: "req-123",
      }),
    )
    expect(okResult(exit).billing).toEqual({ id: "req-123", amount: 0.007 })
  })

  test("missing and malformed cost evidence remains unknown instead of becoming free", async () => {
    const missing = await runCall({ query: "x" }, () => okJson({ results: [] }))
    expect(okResult(missing).billing).toMatchObject({ reason: expect.stringContaining("without reporting") })
    const malformed = await runCall({ query: "x" }, () =>
      okJson({ results: [], requestId: "req-bad", costDollars: { total: "0.007" } }),
    )
    expect(okResult(malformed).billing).toMatchObject({
      id: "req-bad",
      reason: expect.stringContaining("invalid billed amount"),
    })
  })

  test("builds immutable recorded and unknown goal receipts from the host response", () => {
    const sessionID = SessionID.make("ses_websearch_charge")
    const messageID = MessageID.make("msg_websearch_charge")
    const base = { sessionID, messageID, callID: "call_websearch", at: 123 }
    expect(webSearchCharge({ ...base, billing: { id: "req-123", amount: 0.007 } })).toMatchObject({
      kind: "tool",
      provider: "Kilo",
      service: "Exa Web Search",
      source: "kilo-exa.costDollars.total",
      origin: { sessionID, messageID, callID: "call_websearch" },
      at: 123,
      coverage: "recorded",
      amount: 0.007,
      currency: "USD",
    })
    const unknown = webSearchCharge({ ...base, billing: { reason: "Provider amount missing." } })
    expect(unknown).toMatchObject({ coverage: "unknown", currency: "USD", reason: "Provider amount missing." })
    expect(unknown.id).toMatch(/^websearch:kilo-exa:[a-f0-9]{64}$/)
  })
})

describe("callKiloExa error handling", () => {
  test("dies with auth-required message on 401", async () => {
    const exit = await runCall({ query: "x" }, () => jsonResponse(401, {}))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) return
    expect(String((exit as Extract<typeof exit, { _tag: "Failure" }>).cause)).toContain("unauthorized")
    expect(String((exit as Extract<typeof exit, { _tag: "Failure" }>).cause)).toContain("kilo auth login")
  })

  test("dies with auth-required message on 403", async () => {
    const exit = await runCall({ query: "x" }, () => jsonResponse(403, {}))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) return
    expect(String((exit as Extract<typeof exit, { _tag: "Failure" }>).cause)).toContain("unauthorized")
  })

  test("dies with status code on other non-2xx", async () => {
    const exit = await runCall({ query: "x" }, () => jsonResponse(500, { error: "boom" }))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) return
    expect(String((exit as Extract<typeof exit, { _tag: "Failure" }>).cause)).toContain("500")
  })

  test("dies when response body is not valid ExaResponse shape", async () => {
    const exit = await runCall({ query: "x" }, () => okJson({ nope: true }))
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe("executeKiloExa billing boundary", () => {
  const ids = {
    sessionID: SessionID.make("ses_websearch_boundary"),
    messageID: MessageID.make("msg_websearch_boundary"),
    callID: "call_websearch_boundary",
    at: 123,
  }

  test("does not contact the provider when budget admission is denied", async () => {
    const events: string[] = []
    const exit = await Effect.runPromiseExit(
      admitKiloExa({
        http: fakeHttp(() => {
          events.push("request")
          return okJson({ results: [] })
        }),
        params: { query: "x" },
        token: "token",
        claim: Effect.fail(new Error("USD budget exhausted")),
        ...ids,
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(events).toEqual([])
  })

  test("dispatches before the request and settles the exact receipt before release", async () => {
    const events: string[] = []
    const http = fakeHttp(() => {
      events.push("request")
      return okJson({ results: [], requestId: "req-boundary", costDollars: { total: 0.007 } })
    })
    const result = await Effect.runPromise(
      executeKiloExa({
        http,
        params: { query: "x" },
        token: "token",
        lease: {
          dispatch: Effect.sync(() => events.push("dispatch")),
          settle: (charge) =>
            Effect.sync(() => {
              events.push(`settle:${charge.id}:${charge.coverage}`)
            }),
          release: Effect.sync(() => events.push("release")),
        },
        ...ids,
      }),
    )
    expect(events).toEqual(["dispatch", "request", `settle:${result.charge.id}:recorded`, "release"])
    expect(result.charge).toMatchObject({ coverage: "recorded", amount: 0.007, currency: "USD" })
  })

  test("releases a reservation when dispatch fails and never calls the provider", async () => {
    const events: string[] = []
    const exit = await Effect.runPromiseExit(
      executeKiloExa({
        http: fakeHttp(() => {
          events.push("request")
          return okJson({ results: [] })
        }),
        params: { query: "x" },
        token: "token",
        lease: {
          dispatch: Effect.fail(new Error("reservation lost")),
          settle: () => Effect.sync(() => events.push("settle")),
          release: Effect.sync(() => events.push("release")),
        },
        ...ids,
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(events).toEqual(["release"])
  })

  test("does not release a dispatched lease when the provider response fails", async () => {
    const events: string[] = []
    const exit = await Effect.runPromiseExit(
      executeKiloExa({
        http: fakeHttp(() => {
          events.push("request")
          return jsonResponse(500, { error: "lost upstream receipt" })
        }),
        params: { query: "x" },
        token: "token",
        lease: {
          dispatch: Effect.sync(() => events.push("dispatch")),
          settle: () => Effect.sync(() => events.push("settle")),
          release: Effect.sync(() => events.push("release")),
        },
        ...ids,
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(events).toEqual(["dispatch", "request"])
  })

  test("does not release a dispatched lease when the provider never returns", async () => {
    const events: string[] = []
    const http = HttpClient.make(() => Effect.never)
    const exit = await Effect.runPromiseExit(
      executeKiloExa({
        http,
        params: { query: "x" },
        token: "token",
        lease: {
          dispatch: Effect.sync(() => events.push("dispatch")),
          settle: () => Effect.sync(() => events.push("settle")),
          release: Effect.sync(() => events.push("release")),
        },
        ...ids,
      }).pipe(Effect.timeout("10 millis")),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(events).toEqual(["dispatch"])
  })

  test("keeps the receipt available and releases ownership when immediate settlement fails", async () => {
    const events: string[] = []
    const result = await Effect.runPromise(
      executeKiloExa({
        http: fakeHttp(() => {
          events.push("request")
          return okJson({ results: [], requestId: "req-deferred", costDollars: { total: 0.01 } })
        }),
        params: { query: "x" },
        token: "token",
        lease: {
          dispatch: Effect.sync(() => events.push("dispatch")),
          settle: () => Effect.fail(new Error("storage unavailable")),
          release: Effect.sync(() => events.push("release")),
        },
        ...ids,
      }),
    )
    expect(events).toEqual(["dispatch", "request", "release"])
    expect(result.charge).toMatchObject({ coverage: "recorded", amount: 0.01 })
  })

  test("keeps same-call receipts immutable and separates a changed tool-call origin", () => {
    const first = webSearchCharge({ ...ids, billing: { id: "req-retry", amount: 0.01 } })
    const replay = webSearchCharge({ ...ids, billing: { id: "req-retry", amount: 0.01 } })
    const next = webSearchCharge({ ...ids, callID: "call_retry", billing: { id: "req-retry", amount: 0.01 } })
    expect(replay).toEqual(first)
    expect(next.id).not.toBe(first.id)
  })
})
