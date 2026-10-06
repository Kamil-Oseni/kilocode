import { describe, expect, it, spyOn } from "bun:test"
import type { KiloClient } from "@kilocode/sdk/v2/client"
import { abortSession, SessionAbort, webviewAbortSource } from "../../src/kilo-provider/abort"

function client(calls: unknown[], fail = false) {
  return {
    session: {
      abort: async (params: unknown, opts: unknown) => {
        calls.push({ type: "abort", params, opts })
        if (fail) throw new Error("abort failed")
        return { data: true }
      },
    },
  } as unknown as KiloClient
}

describe("SessionAbort", () => {
  it("stops the active owner and current mapped directory", async () => {
    const calls: unknown[] = []
    const aborts = new SessionAbort()
    aborts.observe("session_1", "busy", "/repo")

    expect(await aborts.stop(client(calls), "session_1", "/repo/worktree", "user-stop")).toBe(true)
    expect(calls).toEqual([
      {
        type: "abort",
        params: { sessionID: "session_1", directory: "/repo" },
        opts: { throwOnError: true },
      },
      {
        type: "abort",
        params: { sessionID: "session_1", directory: "/repo/worktree" },
        opts: { throwOnError: true },
      },
    ])
  })

  it("forgets an owner when its instance becomes idle", async () => {
    const calls: unknown[] = []
    const aborts = new SessionAbort()
    aborts.observe("session_1", "busy", "/repo")
    aborts.observe("session_1", "idle", "/repo")

    expect(await aborts.stop(client(calls), "session_1", "/repo/worktree", "user-stop")).toBe(false)
    expect(calls).toEqual([
      {
        type: "abort",
        params: { sessionID: "session_1", directory: "/repo/worktree" },
        opts: { throwOnError: true },
      },
    ])
  })

  it("deduplicates equivalent directory paths", async () => {
    const calls: unknown[] = []
    const aborts = new SessionAbort()
    aborts.observe("session_1", "busy", "/repo/worktree")

    expect(await aborts.stop(client(calls), "session_1", "/repo/worktree/.", "user-stop")).toBe(true)
    expect(calls).toHaveLength(1)
  })
})

describe("abortSession", () => {
  it("calls session.abort with the session id and directory", async () => {
    const calls: unknown[] = []

    await abortSession({ client: client(calls), sessionID: "session_1", dir: "/repo", source: "user-stop" })

    expect(calls).toEqual([
      {
        type: "abort",
        params: { sessionID: "session_1", directory: "/repo" },
        opts: { throwOnError: true },
      },
    ])
  })

  it("rejects when the abort request fails", async () => {
    const calls: unknown[] = []

    await expect(abortSession({ client: client(calls, true), sessionID: "session_1", dir: "/repo", source: "user-stop" })).rejects.toThrow(
      "abort failed",
    )

    expect(calls).toEqual([
      {
        type: "abort",
        params: { sessionID: "session_1", directory: "/repo" },
        opts: { throwOnError: true },
      },
    ])
  })

  it("logs only opaque abort provenance before a failed request", async () => {
    const log = spyOn(console, "info").mockImplementation(() => {})
    const calls: unknown[] = []
    try {
      await expect(
        abortSession({ client: client(calls, true), sessionID: "session_1", dir: "/private/repo", source: "cost-alert-stop" }),
      ).rejects.toThrow("abort failed")
      expect(log).toHaveBeenCalledWith("[Raya] Session abort requested", {
        sessionID: "session_1",
        source: "cost-alert-stop",
      })
      expect(JSON.stringify(log.mock.calls)).not.toContain("/private/repo")
    } finally {
      log.mockRestore()
    }
  })

  it("does not trust an unrecognized webview source", () => {
    expect(webviewAbortSource("host-session-management")).toBe("unknown-webview")
    expect(webviewAbortSource({ source: "user-stop" })).toBe("unknown-webview")
    expect(webviewAbortSource("user-escape")).toBe("user-escape")
  })
})
