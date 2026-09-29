import { describe, expect, it } from "bun:test"

const { KiloProvider } = await import("../../src/KiloProvider")

type Reply = { type: string; sessionID: string; requestID: string; jobs: unknown[]; error?: string }
type Context = {
  client: { kilocode: { backgroundJobs: () => Promise<{ data: unknown[] }> } }
  connectionState: "connected"
  jobsBackoff: number
  getWorkspaceDirectory: () => string
  postMessage: (message: Reply) => void
}

describe("background job refresh", () => {
  it("reports fetch failure and backoff as unavailable, then publishes the recovered worker list", async () => {
    const sent: Reply[] = []
    const jobs = [{ id: "worker", status: "running" }]
    let calls = 0
    const state: Context = {
      client: {
        kilocode: {
          backgroundJobs: async () => {
            calls++
            if (calls === 1) throw new Error("controlled backend failure")
            return { data: jobs }
          },
        },
      },
      connectionState: "connected",
      jobsBackoff: 0,
      getWorkspaceDirectory: () => "C:\\workspace",
      postMessage: (message) => sent.push(message),
    }
    const provider = KiloProvider.prototype as unknown as {
      fetchAndSendBackgroundJobs: (this: Context, sessionID: string, requestID: string) => Promise<void>
    }

    await provider.fetchAndSendBackgroundJobs.call(state, "parent", "first")
    expect(sent[0]).toMatchObject({ requestID: "first", jobs: [], error: expect.any(String) })
    await provider.fetchAndSendBackgroundJobs.call(state, "parent", "backoff")
    expect(sent[1]).toMatchObject({ requestID: "backoff", jobs: [], error: expect.any(String) })
    expect(calls).toBe(1)

    state.jobsBackoff = 0
    await provider.fetchAndSendBackgroundJobs.call(state, "parent", "recovered")
    expect(sent[2]).toEqual({ type: "backgroundJobsLoaded", sessionID: "parent", requestID: "recovered", jobs })
    expect(calls).toBe(2)
  })
})
