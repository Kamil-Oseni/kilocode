import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as Billing from "@/kilocode/tool/dictation-billing"

const lease = (events: string[], fail?: "dispatch" | "finish" | "uncertain"): Billing.Lease => ({
  dispatch:
    fail === "dispatch" ? Effect.fail(new Error("dispatch failed")) : Effect.sync(() => void events.push("dispatch")),
  finish: fail === "finish" ? Effect.fail(new Error("finish failed")) : Effect.sync(() => void events.push("finish")),
  release: Effect.sync(() => void events.push("release")),
  uncertain: () =>
    fail === "uncertain"
      ? Effect.fail(new Error("settlement failed"))
      : Effect.sync(() => void events.push("uncertain")),
})

describe("hosted dictation billing", () => {
  test("requires paired identities and derives a stable session-bound key", () => {
    expect(Billing.identify("ses_one", undefined)).toEqual({ ok: false })
    expect(Billing.identify(undefined, "req_one")).toEqual({ ok: false })
    expect(Billing.identify(undefined, undefined)).toEqual({ ok: true })
    const first = Billing.identify("ses_one", "req_one")
    const retry = Billing.identify("ses_one", "req_one")
    const other = Billing.identify("ses_two", "req_one")
    expect(first).toEqual(retry)
    expect(first).not.toEqual(other)
    expect(first.value).toMatch(/^dictation:[a-f0-9]{64}$/)
  })

  test("never forwards local accounting identities to the hosted provider", () => {
    expect(
      Billing.payload({
        requestID: "req_private",
        sessionID: "ses_private",
        model: "whisper",
        input_audio: { data: "audio", format: "wav" },
        language: "en",
        prompt: "Names",
        temperature: 0,
      }),
    ).toEqual({
      model: "whisper",
      input_audio: { data: "audio", format: "wav" },
      language: "en",
      prompt: "Names",
      temperature: 0,
    })
  })

  test("dispatches before a successful request and settles unknown before returning", async () => {
    const events: string[] = []
    const result = await Effect.runPromise(
      Billing.run(
        lease(events),
        Effect.sync(() => {
          events.push("send")
          return Response.json({ text: "hello" })
        }),
      ),
    )
    expect(result.text).toBe('{"text":"hello"}')
    expect(events).toEqual(["dispatch", "send", "uncertain", "release"])
  })

  test("finalizes an explicit provider refusal", async () => {
    const events: string[] = []
    await Effect.runPromise(Billing.run(lease(events), Effect.succeed(new Response("denied", { status: 403 }))))
    expect(events).toEqual(["dispatch", "finish", "release"])
  })

  test("retains uncertainty for server failures and timeout responses", async () => {
    for (const status of [408, 499, 500, 503]) {
      const events: string[] = []
      const result = await Effect.runPromise(
        Billing.run(lease(events), Effect.succeed(new Response("lost", { status }))),
      )
      expect(result.response.status).toBe(status)
      expect(events).toEqual(["dispatch", "release"])
    }
  })

  test("retains dispatched uncertainty when transport acknowledgement is lost", async () => {
    const events: string[] = []
    await expect(
      Effect.runPromise(Billing.run(lease(events), Effect.fail(new Error("connection lost")))),
    ).rejects.toThrow("connection lost")
    expect(events).toEqual(["dispatch", "release"])
  })

  test("does not send when durable dispatch or settlement fails", async () => {
    for (const failure of ["dispatch", "uncertain"] as const) {
      const events: string[] = []
      const send = Effect.sync(() => {
        events.push("send")
        return Response.json({ text: "hello" })
      })
      await expect(Effect.runPromise(Billing.run(lease(events, failure), send))).rejects.toThrow()
      expect(events).toEqual(failure === "dispatch" ? ["release"] : ["dispatch", "send", "release"])
    }
  })

  test("does not require a goal lease for unbound dictation", async () => {
    const result = await Effect.runPromise(Billing.run(undefined, Effect.succeed(Response.json({ text: "hello" }))))
    expect(result.response.status).toBe(200)
  })
})
