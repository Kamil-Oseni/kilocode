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

  it("keeps fresh health when the diagnostic request throws", async () => {
    const posts: unknown[] = []
    const health = { format: "raya.admin-health" as const, version: 1 as const, generatedAt: 1, items: [] }
    const client = {
      raya: {
        admin: {
          health: async () => ({ data: health }),
          logs: async () => {
            throw new Error("C:/private token=synthetic-log-secret")
          },
        },
      },
    } as unknown as KiloClient

    await handleAdminMessage({
      client,
      directory: "/workspace",
      message: { type: "requestAdmin", requestID: "req_3" },
      post: (message) => posts.push(message),
    })
    expect(JSON.stringify(posts)).not.toContain("private")
    expect(JSON.stringify(posts)).not.toContain("synthetic")
    expect(posts).toEqual([
      {
        type: "adminResult",
        requestID: "req_3",
        health,
        error: { kind: "error", message: "Health is available, but diagnostics couldn't be loaded." },
      },
    ])
  })

  it("replaces unknown browser and voice rows with current extension-host signals", async () => {
    const posts: unknown[] = []
    const row = (id: "runtime" | "sessions" | "routines" | "agents" | "browser" | "voice") => ({
      id,
      status: "unknown" as const,
      reason: "not-checked" as const,
      observedAt: 25,
    })
    const health = {
      format: "raya.admin-health" as const,
      version: 1 as const,
      generatedAt: 25,
      items: ["runtime", "sessions", "routines", "agents", "browser", "voice"].map((id) =>
        row(id as Parameters<typeof row>[0]),
      ),
    }
    const client = {
      raya: { admin: { health: async () => ({ data: health }), logs: async () => ({ data: [] }) } },
    } as unknown as KiloClient

    await handleAdminMessage({
      client,
      directory: "/workspace",
      message: { type: "requestAdmin", requestID: "req_host" },
      host: {
        browser: () => ({ status: "ready" }),
        voice: () => ({ available: true, active: 1 }),
      },
      post: (message) => posts.push(message),
    })

    const result = posts[0] as { health: typeof health }
    expect(result.health.items.find((item) => item.id === "browser")).toEqual({
      id: "browser",
      status: "healthy",
      reason: "ready",
      observedAt: 25,
    })
    expect(result.health.items.find((item) => item.id === "voice")).toEqual({
      id: "voice",
      status: "healthy",
      reason: "ready",
      observedAt: 25,
      metrics: { active: 1 },
    })
  })

  it("fails closed when an extension-host probe throws or returns invalid data", async () => {
    const posts: unknown[] = []
    const health = {
      format: "raya.admin-health" as const,
      version: 1 as const,
      generatedAt: 30,
      items: ["runtime", "sessions", "routines", "agents", "browser", "voice"].map((id) => ({
        id: id as "runtime" | "sessions" | "routines" | "agents" | "browser" | "voice",
        status: "unknown" as const,
        reason: "not-checked" as const,
        observedAt: 30,
      })),
    }
    const client = {
      raya: { admin: { health: async () => ({ data: health }), logs: async () => ({ data: [] }) } },
    } as unknown as KiloClient

    await handleAdminMessage({
      client,
      directory: "/workspace",
      message: { type: "requestAdmin", requestID: "req_host_failed" },
      host: {
        browser: () => {
          throw new Error("C:/private browser token")
        },
        voice: () => ({ available: true, active: Number.NaN }),
      },
      post: (message) => posts.push(message),
    })

    expect(JSON.stringify(posts)).not.toContain("private")
    const items = (posts[0] as { health: typeof health }).health.items
    expect(items.find((item) => item.id === "browser")).toEqual({
      id: "browser",
      status: "unknown",
      reason: "probe-failed",
      observedAt: 30,
    })
    expect(items.find((item) => item.id === "voice")).toEqual({
      id: "voice",
      status: "unknown",
      reason: "probe-failed",
      observedAt: 30,
    })
  })
})
