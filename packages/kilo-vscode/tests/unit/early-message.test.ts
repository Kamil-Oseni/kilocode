import { describe, expect, it } from "bun:test"
import { routeEarlyMessage } from "../../src/kilo-provider/early-message"

type Ctx = Parameters<typeof routeEarlyMessage>[1]

function context(copied: string[], posted: unknown[], fail = false) {
  return {
    copy: async (text: string) => {
      if (fail) throw new Error("clipboard unavailable")
      copied.push(text)
    },
    post: (message: unknown) => posted.push(message),
  } as Ctx
}

it("routes original conversation report-card reads through the host early-message boundary", async () => {
  const received: unknown[] = []
  const posted: unknown[] = []
  const ctx = context([], posted)
  ctx.reports = async (message) => {
    received.push(message)
    return true
  }
  const message = { type: "agentReportsRead", requestID: "original-view", sessionID: "original-session" }
  expect(await routeEarlyMessage(message, ctx)).toBe(true)
  expect(received).toEqual([message])
  expect(posted).toEqual([])
})

describe("routeEarlyMessage clipboard handling", () => {
  it("routes clipboard text to the host", async () => {
    const copied: string[] = []
    const posted: unknown[] = []

    const handled = await routeEarlyMessage(
      { type: "copyToClipboard", id: "copy-1", text: "message text" },
      context(copied, posted),
    )

    expect(handled).toBe(true)
    expect(copied).toEqual(["message text"])
    expect(posted).toEqual([{ type: "clipboardWriteResult", id: "copy-1", ok: true }])
  })

  it("reports host clipboard failures", async () => {
    const copied: string[] = []
    const posted: unknown[] = []

    const handled = await routeEarlyMessage(
      { type: "copyToClipboard", id: "copy-2", text: "message text" },
      context(copied, posted, true),
    )

    expect(handled).toBe(true)
    expect(copied).toEqual([])
    expect(posted).toEqual([{ type: "clipboardWriteResult", id: "copy-2", ok: false, error: "clipboard unavailable" }])
  })
})

describe("routeEarlyMessage background jobs", () => {
  it("forwards exact local inference request correlation and rejects malformed reads", async () => {
    const calls: unknown[] = []
    const ctx = {
      localInference: async (sessionID: string, requestID: string) => calls.push([sessionID, requestID]),
    } as Ctx
    expect(
      await routeEarlyMessage({ type: "requestLocalInference", sessionID: "ses_parent", requestID: "queue-1" }, ctx),
    ).toBe(true)
    expect(await routeEarlyMessage({ type: "requestLocalInference", sessionID: 1, requestID: "bad" }, ctx)).toBe(true)
    expect(calls).toEqual([["ses_parent", "queue-1"]])
  })

  it("forwards list request correlation", async () => {
    const calls: unknown[] = []
    const ctx = {
      backgroundJobs: async (sessionID: string, requestID: string) => calls.push([sessionID, requestID]),
    } as Ctx

    expect(
      await routeEarlyMessage({ type: "requestBackgroundJobs", sessionID: "ses_parent", requestID: "request-1" }, ctx),
    ).toBe(true)
    expect(calls).toEqual([["ses_parent", "request-1"]])
  })

  it("forwards cancellation through the owning parent session", async () => {
    const calls: unknown[] = []
    const ctx = {
      cancelBackgroundJob: async (jobID: string, sessionID: string, requestID: string, revision: string) =>
        calls.push([jobID, sessionID, requestID, revision]),
    } as Ctx

    expect(
      await routeEarlyMessage(
        {
          type: "cancelBackgroundJob",
          jobID: "ses_child",
          revision: "displayed",
          sessionID: "ses_parent",
          requestID: "request-2",
        },
        ctx,
      ),
    ).toBe(true)
    expect(calls).toEqual([["ses_child", "ses_parent", "request-2", "displayed"]])
  })
})

describe("routeEarlyMessage child steering", () => {
  it("forwards only the dedicated correlated child request", async () => {
    const calls: unknown[] = []
    const ctx = {
      childSteer: async (message: unknown) => calls.push(message),
    } as Ctx
    const message = {
      type: "steerChildSession",
      parentSessionID: "ses_parent",
      childSessionID: "ses_child",
      messageID: "msg_1",
      text: "Keep the exact scope",
    }

    expect(await routeEarlyMessage(message, ctx)).toBe(true)
    expect(calls).toEqual([message])
  })
})

for (const revision of [undefined, "", 1])
  it(`does not dispatch a Stop without a displayed revision (${String(revision)})`, async () => {
    const calls: unknown[] = []
    const ctx = {
      cancelBackgroundJob: async (...args: unknown[]) => {
        calls.push(args)
      },
    } as Ctx
    expect(
      await routeEarlyMessage(
        { type: "cancelBackgroundJob", jobID: "child", sessionID: "parent", requestID: "stop", revision },
        ctx,
      ),
    ).toBe(true)
    expect(calls).toEqual([])
  })
