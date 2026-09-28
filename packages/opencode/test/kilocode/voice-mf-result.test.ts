import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Result, ResultError, send } from "@/kilocode/voice/mf-result"

function item(): typeof Result.Type {
  return {
    version: 2,
    delegationID: "delegation_original",
    receiptID: "receipt_original",
    kind: "delegation.result",
    content: "Synthetic retained result",
    ttl: 10000,
    created: new Date().toISOString(),
  }
}
function site(handle?: (request: Request) => Response | Promise<Response>) {
  const calls: Array<{ path: string; auth: string | null; key: string | null; body: string }> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      calls.push({
        path: new URL(request.url).pathname,
        auth: request.headers.get("Authorization"),
        key: request.headers.get("X-Raya-Media-Key"),
        body: await request.clone().text(),
      })
      if (handle) return handle(request)
      const body = (await request.json()) as typeof Result.Type
      return Response.json(
        {
          version: 2,
          sessionID: "rvs_original",
          delegationID: body.delegationID,
          receiptID: body.receiptID,
          accepted: true,
          played: false,
        },
        { status: 202 },
      )
    },
  })
  return { calls, url: server.url.origin, stop: () => server.stop(true) }
}
const key = "K".repeat(43)
const token = "T".repeat(43)

test("MF result uses original authenticated owner and exact v2 acceptance, never playback", async () => {
  const source = site()
  const result = item()
  try {
    expect(await send(source.url, "rvs_original", key, token, result)).toEqual({
      version: 2,
      sessionID: "rvs_original",
      delegationID: result.delegationID,
      receiptID: result.receiptID,
      accepted: true,
      played: false,
    })
    expect(source.calls).toHaveLength(1)
    expect(source.calls[0]).toMatchObject({ path: "/v1/sessions/rvs_original/result", auth: `Bearer ${token}`, key })
    expect(JSON.parse(source.calls[0]!.body)).toEqual(result)
    expect(source.calls[0]!.body).not.toContain(token)
    expect(source.calls[0]!.body).not.toContain(key)
  } finally {
    source.stop()
  }
})

test("MF result validates bounded strict input before any credentials are sent", async () => {
  const source = site()
  try {
    for (const patch of [
      { version: 1 },
      { delegationID: "delegation\n" },
      { receiptID: "receipt\n" },
      { constructor: "extra" },
      JSON.parse('{"__proto__":"extra"}') as Record<string, unknown>,
      { content: "é".repeat(251) },
      { content: "\ud800" },
      { content: "" },
      { ttl: -1 },
      { ttl: 1.5 },
      { ttl: Number.POSITIVE_INFINITY },
      { created: "not a date" },
      { created: "2026-02-30T00:00:00.000Z" },
    ])
      await expect(
        send(source.url, "rvs_original", key, token, { ...item(), ...patch } as typeof Result.Type),
      ).rejects.toMatchObject({ status: "refused" })
    await expect(
      send(source.url, "rvs_original", key, token, { ...item(), ttl: 1, created: "2020-01-01T00:00:00.000Z" }),
    ).rejects.toMatchObject({ status: "refused" })
    expect(source.calls).toEqual([])
    expect(Schema.is(Result)({ ...item(), delegationID: "id\n" })).toBe(false)
  } finally {
    source.stop()
  }
})

test("MF result rejects unsafe destinations and credentials before HTTP", async () => {
  const source = site()
  try {
    for (const url of [
      "http://localhost:7890",
      "http://media.example",
      "http://127.1:7890",
      "http://2130706433:7890",
      `${source.url}/path`,
      `${source.url}?target=remote`,
      `${source.url}\n`,
    ])
      await expect(send(url, "rvs_original", key, token, item())).rejects.toMatchObject({ status: "refused" })
    for (const value of ["", "short", `${token}\n`])
      await expect(send(source.url, "rvs_original", key, value, item())).rejects.toMatchObject({ status: "refused" })
    await expect(send(source.url, "rvs_original", key, token, item(), AbortSignal.abort())).rejects.toMatchObject({
      status: "refused",
    })
    expect(source.calls).toEqual([])
  } finally {
    source.stop()
  }
})

test("MF result rejects wrong identities and malformed acceptance without replay", async () => {
  for (const patch of [
    { version: 1 },
    { sessionID: "rvs_other" },
    { delegationID: "other" },
    { receiptID: "other" },
    { accepted: false },
    { played: true },
    { extra: true },
    { receiptID: "receipt_original\n" },
  ]) {
    const source = site(() =>
      Response.json(
        {
          version: 2,
          sessionID: "rvs_original",
          delegationID: "delegation_original",
          receiptID: "receipt_original",
          accepted: true,
          played: false,
          ...patch,
        },
        { status: 202 },
      ),
    )
    try {
      await expect(send(source.url, "rvs_original", key, token, item())).rejects.toMatchObject({ status: "unknown" })
      expect(source.calls).toHaveLength(1)
    } finally {
      source.stop()
    }
  }
  for (const body of ["", "{}", "null", "{bad", '{"version":2} trailing', "x".repeat(2049)]) {
    const source = site(() => new Response(body, { status: 202 }))
    try {
      await expect(send(source.url, "rvs_original", key, token, item())).rejects.toMatchObject({ status: "unknown" })
      expect(source.calls).toHaveLength(1)
    } finally {
      source.stop()
    }
  }
})

test("MF result distinguishes definite HTTP refusal from uncertain effects without exposing response content", async () => {
  for (const status of [400, 401, 403, 404, 409, 422, 429, 503]) {
    const source = site(() => new Response("private provider content and secrets", { status }))
    try {
      const failure = await send(source.url, "rvs_original", key, token, item()).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(ResultError)
      expect((failure as ResultError).status).toBe([400, 401, 403, 404, 422].includes(status) ? "refused" : "unknown")
      expect(String(failure)).not.toContain("private")
      expect(source.calls).toHaveLength(1)
    } finally {
      source.stop()
    }
  }
})

test("MF result refuses redirects to same or different origins without leaking credentials", async () => {
  const target = site()
  try {
    for (const remote of [false, true])
      for (const status of [301, 302, 303, 307, 308]) {
        const source = site(
          (request) =>
            new Response(null, {
              status,
              headers: { Location: `${remote ? target.url : new URL(request.url).origin}/redirected` },
            }),
        )
        try {
          await expect(send(source.url, "rvs_original", key, token, item())).rejects.toMatchObject({
            status: "unknown",
          })
          expect(source.calls).toHaveLength(1)
        } finally {
          source.stop()
        }
      }
    expect(target.calls).toEqual([])
  } finally {
    target.stop()
  }
})

test("MF result bounds response body lifetime and never retries a lost acknowledgement", async () => {
  const source = site(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"version":2,'))
          },
        }),
        { status: 202 },
      ),
  )
  try {
    const begin = Date.now()
    await expect(send(source.url, "rvs_original", key, token, { ...item(), ttl: 80 })).rejects.toMatchObject({
      status: "unknown",
    })
    expect(Date.now() - begin).toBeLessThan(2000)
    expect(source.calls).toHaveLength(1)
  } finally {
    source.stop()
  }
})

test("MF result Stop aborts its owned HTTP attempt without replay", async () => {
  const control = new AbortController()
  const source = site(() => {
    control.abort()
    return new Response("unconfirmed", { status: 202 })
  })
  try {
    await expect(send(source.url, "rvs_original", key, token, item(), control.signal)).rejects.toMatchObject({
      status: "unknown",
    })
    expect(source.calls).toHaveLength(1)
  } finally {
    source.stop()
  }
})
