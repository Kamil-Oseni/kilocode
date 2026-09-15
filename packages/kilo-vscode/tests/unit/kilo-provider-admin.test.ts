import { describe, expect, it } from "bun:test"
import type { KiloClient } from "@kilocode/sdk/v2/client"
import { handleAdminMessage } from "../../src/kilo-provider/admin"

describe("admin host bridge", () => {
  it("uses the generated read-only endpoints in order", async () => {
    const calls: string[] = []
    const posts: unknown[] = []
    const client = {
      raya: {
        admin: {
          health: async () => {
            calls.push("health")
            return { data: { format: "raya.admin-health", version: 1, generatedAt: 1, items: [] } }
          },
          logs: async () => {
            calls.push("logs")
            return { data: [] }
          },
        },
      },
    } as unknown as KiloClient

    expect(
      await handleAdminMessage({
        client,
        directory: "/workspace",
        message: { type: "requestAdmin", requestID: "req_1" },
        post: (message) => posts.push(message),
      }),
    ).toBe(true)
    expect(calls).toEqual(["health", "logs"])
    expect(posts).toEqual([
      {
        type: "adminResult",
        requestID: "req_1",
        health: { format: "raya.admin-health", version: 1, generatedAt: 1, items: [] },
        logs: [],
      },
    ])
  })

  it("never forwards raw backend failures", async () => {
    const posts: unknown[] = []
    const client = {
      raya: {
        admin: {
          health: async () => {
            throw new Error("C:/private token=synthetic-secret")
          },
        },
      },
    } as unknown as KiloClient

    await handleAdminMessage({
      client,
      directory: "/workspace",
      message: { type: "requestAdmin", requestID: "req_2" },
      post: (message) => posts.push(message),
    })
    expect(JSON.stringify(posts)).not.toContain("private")
    expect(JSON.stringify(posts)).not.toContain("synthetic")
    expect(posts).toEqual([
      {
        type: "adminResult",
        requestID: "req_2",
        error: { kind: "offline", message: "The connection was interrupted. Reconnect, then try again." },
      },
    ])
  })
})
