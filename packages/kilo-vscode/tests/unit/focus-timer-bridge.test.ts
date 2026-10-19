import { describe, expect, it } from "bun:test"
import type { KiloClient } from "@kilocode/sdk/v2/client"
import { handleFocusTimerMessage } from "../../src/kilo-provider/focus-timer"

const timer = {
  version: 1 as const,
  state: "running" as const,
  durationMs: 1_500_000,
  elapsedMs: 60_000,
  remainingMs: 1_440_000,
  startedAt: 10,
  runStartedAt: 10,
  updatedAt: 10,
  revision: 4,
}

function client(focusTimer: Record<string, (...args: never[]) => unknown>) {
  return { raya: { focusTimer } } as unknown as KiloClient
}

describe("focus timer extension bridge", () => {
  it("withholds a stale-action latest payload when its scope changes during the one conflict refresh", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const scope = { current: true }
    const calls: string[] = []
    const api = client({
      pause: async () => {
        calls.push("pause")
        return {
          error: {
            name: "FocusTimerStaleRevisionError",
            data: { expected: 4, actual: 7, message: "Original conflict" },
          },
          response: { status: 409 },
        }
      },
      get: async () => {
        calls.push("get")
        entered.resolve()
        await release.promise
        return { data: { ...timer, revision: 7 }, response: { status: 200 } }
      },
    })
    const messages: unknown[] = []
    const work = handleFocusTimerMessage({
      client: api,
      directory: "C:/work",
      current: () => scope.current,
      message: { type: "focusTimerPause", requestID: "held-refresh", revision: 4 },
      post: (message) => messages.push(message),
    })
    try {
      await entered.promise
      scope.current = false
    } finally {
      release.resolve()
      await work
    }
    expect(calls).toEqual(["pause", "get"])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ error: { kind: "uncertain" } })
    expect(JSON.stringify(messages)).not.toContain("latest")
    expect(messages[0]).not.toHaveProperty("timer")
  })

  for (const type of ["focusTimerGet", "focusTimerPause"] as const) {
    it(`refuses an obsolete ${type} scope before dispatch`, async () => {
      const calls: string[] = []
      const api = client(
        Object.fromEntries(
          ["get", "pause"].map((name) => [
            name,
            async () => {
              calls.push(name)
              return { data: timer, response: { status: 200 } }
            },
          ]),
        ),
      )
      const messages: unknown[] = []
      await handleFocusTimerMessage({
        client: api,
        directory: "C:/work",
        current: () => false,
        message: { type, requestID: "obsolete", ...(type === "focusTimerPause" ? { revision: 4 } : {}) },
        post: (message) => messages.push(message),
      })
      expect(calls).toEqual([])
      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({ error: { kind: type === "focusTimerGet" ? "error" : "offline" } })
      expect(messages[0]).not.toHaveProperty("timer")
      expect(JSON.stringify(messages)).not.toContain("unchanged")
    })
  }

  for (const type of ["focusTimerStart", "focusTimerPause", "focusTimerResume", "focusTimerReset"] as const) {
    it(`reports an uncertain ${type} outcome after dispatch without replaying or reading automatically`, async () => {
      const calls: string[] = []
      const api = client(
        Object.fromEntries(
          ["get", "start", "pause", "resume", "reset"].map((name) => [
            name,
            async () => {
              calls.push(name)
              throw new TypeError("Controlled transport failure")
            },
          ]),
        ),
      )
      const messages: unknown[] = []
      await handleFocusTimerMessage({
        client: api,
        directory: "C:/work",
        message: { type, requestID: type, revision: 4, ...(type === "focusTimerStart" ? { durationMs: 60_000 } : {}) },
        post: (message) => messages.push(message),
      })
      expect(calls).toEqual([type.replace("focusTimer", "").toLowerCase()])
      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({ error: { kind: "uncertain" } })
      expect(JSON.stringify(messages)).not.toContain("unchanged")
    })
  }

  it("treats a dispatched GET connection failure as a read failure", async () => {
    const messages: unknown[] = []
    await handleFocusTimerMessage({
      client: client({
        get: async () => {
          throw new TypeError("Controlled read failure")
        },
      }),
      directory: "C:/work",
      message: { type: "focusTimerGet", requestID: "read" },
      post: (message) => messages.push(message),
    })
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ operation: "get", error: { kind: "error" } })
    expect(JSON.stringify(messages)).not.toContain("unchanged")
  })

  it("routes get and revision-fenced actions with the workspace directory", async () => {
    const calls: unknown[] = []
    const api = client(
      Object.fromEntries(
        ["get", "start", "pause", "resume", "reset"].map((operation) => [
          operation,
          async (input: unknown) => {
            calls.push([operation, input])
            return { data: timer, response: { status: 200 } }
          },
        ]),
      ),
    )
    const messages: unknown[] = []
    const post = (message: unknown) => messages.push(message)
    for (const message of [
      { type: "focusTimerGet", requestID: "get" },
      { type: "focusTimerStart", requestID: "start", revision: 3, durationMs: 1_500_000, todoID: "todo_1" },
      { type: "focusTimerPause", requestID: "pause", revision: 4 },
      { type: "focusTimerResume", requestID: "resume", revision: 5 },
      { type: "focusTimerReset", requestID: "reset", revision: 6 },
    ])
      await handleFocusTimerMessage({ client: api, directory: "C:/work", message, post })

    expect(calls).toEqual([
      ["get", { directory: "C:/work" }],
      ["start", { directory: "C:/work", revision: 3, durationMs: 1_500_000, todoID: "todo_1" }],
      ["pause", { directory: "C:/work", revision: 4 }],
      ["resume", { directory: "C:/work", revision: 5 }],
      ["reset", { directory: "C:/work", revision: 6 }],
    ])
    expect(messages).toHaveLength(5)
    expect(messages.at(-1)).toMatchObject({ operation: "reset", timer })
  })

  it("returns the exact latest timer after a stale action", async () => {
    const latest = { ...timer, state: "paused" as const, revision: 7 }
    const api = client({
      pause: async () => ({
        error: {
          name: "FocusTimerStaleRevisionError",
          data: { operation: "pause", expected: 4, actual: 7, message: "The focus timer changed before this action." },
        },
        response: { status: 409 },
      }),
      get: async () => ({ data: latest, response: { status: 200 } }),
    })
    const messages: unknown[] = []
    await handleFocusTimerMessage({
      client: api,
      directory: "C:/work",
      message: { type: "focusTimerPause", requestID: "stale", revision: 4 },
      post: (message) => messages.push(message),
    })
    expect(messages).toEqual([
      {
        type: "focusTimerResult",
        requestID: "stale",
        operation: "pause",
        error: {
          kind: "stale",
          message: "The focus timer changed before this action.",
          expected: 4,
          actual: 7,
          latest,
        },
      },
    ])
  })

  it("keeps offline actions identifiable and rejects out-of-bounds starts", async () => {
    const messages: unknown[] = []
    const post = (message: unknown) => messages.push(message)
    await handleFocusTimerMessage({
      client: null,
      directory: "C:/work",
      message: { type: "focusTimerPause", requestID: "offline", revision: 4 },
      post,
    })
    await handleFocusTimerMessage({
      client: client({}),
      directory: "C:/work",
      message: { type: "focusTimerStart", requestID: "invalid", revision: 4, durationMs: 1 },
      post,
    })
    await handleFocusTimerMessage({
      client: client({
        get: async () => ({
          error: { data: { message: "C:/private token=synthetic-secret" } },
          response: { status: 500 },
        }),
      }),
      directory: "C:/work",
      message: { type: "focusTimerGet", requestID: "error" },
      post,
    })
    expect(messages).toEqual([
      {
        type: "focusTimerResult",
        requestID: "offline",
        operation: "pause",
        error: { kind: "offline", message: "Raya is offline. This focus timer action was not sent." },
      },
      {
        type: "focusTimerResult",
        requestID: "invalid",
        operation: "start",
        error: { kind: "error", message: "This focus timer request was incomplete." },
      },
      {
        type: "focusTimerResult",
        requestID: "error",
        operation: "get",
        error: { kind: "error", message: "Raya could not load the focus timer." },
      },
    ])
    expect(JSON.stringify(messages)).not.toContain("private")
    expect(JSON.stringify(messages)).not.toContain("synthetic")
  })
})
