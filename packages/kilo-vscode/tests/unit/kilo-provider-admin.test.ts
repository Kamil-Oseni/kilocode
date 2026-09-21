import { describe, expect, it } from "bun:test"
import type { KiloClient } from "@kilocode/sdk/v2/client"
import { handleAdminMessage } from "../../src/kilo-provider/admin"

const ids = [
  "runtime",
  "sessions",
  "goals",
  "routines",
  "organizations",
  "scheduler",
  "agents",
  "skills",
  "todos",
  "contacts",
  "browser",
  "computer",
  "voice",
  "memory",
  "canvas",
  "sync",
  "updates",
] as const

describe("admin host bridge", () => {
  it("uses the generated read-only endpoints in order", async () => {
    const calls: string[] = []
    const posts: unknown[] = []
    const client = {
      raya: {
        admin: {
          health: async () => {
            calls.push("health")
            return { data: { format: "raya.admin-health", version: 2, generatedAt: 1, items: [] } }
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
        health: { format: "raya.admin-health", version: 2, generatedAt: 1, items: [] },
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
    const health = { format: "raya.admin-health" as const, version: 2 as const, generatedAt: 1, items: [] }
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

  it("replaces unknown browser, voice, and update rows with current extension-host signals", async () => {
    const posts: unknown[] = []
    const row = (id: (typeof ids)[number]) => ({
      id,
      status: "unknown" as const,
      reason: "not-checked" as const,
      observedAt: 25,
    })
    const health = {
      format: "raya.admin-health" as const,
      version: 2 as const,
      generatedAt: 25,
      items: ids.map(row),
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
        voice: () => ({ available: true, active: 1, failed: 0, incomplete: 0 }),
        updates: () => ({ status: "ready" }),
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
      metrics: { active: 1, failed: 0, incomplete: 0 },
    })
    expect(result.health.items.find((item) => item.id === "updates")).toEqual({
      id: "updates",
      status: "healthy",
      reason: "ready",
      observedAt: 25,
    })
  })

  it("fails closed when an extension-host probe throws or returns invalid data", async () => {
    const posts: unknown[] = []
    const health = {
      format: "raya.admin-health" as const,
      version: 2 as const,
      generatedAt: 30,
      items: ids.map((id) => ({
        id,
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
        voice: () => ({ available: true, active: Number.NaN, failed: 0, incomplete: 0 }),
        updates: () => {
          throw new Error("C:/private update token")
        },
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
    expect(items.find((item) => item.id === "updates")).toEqual({
      id: "updates",
      status: "unknown",
      reason: "probe-failed",
      observedAt: 30,
    })
  })

  it("retains closed Voice failure and incomplete lifecycle states", async () => {
    const posts: unknown[] = []
    const health = {
      format: "raya.admin-health" as const,
      version: 2 as const,
      generatedAt: 35,
      items: ids.map((id) => ({
        id,
        status: "unknown" as const,
        reason: "not-checked" as const,
        observedAt: 35,
      })),
    }
    const client = {
      raya: { admin: { health: async () => ({ data: health }), logs: async () => ({ data: [] }) } },
    } as unknown as KiloClient
    const read = async (requestID: string, failed: number, incomplete: number) => {
      await handleAdminMessage({
        client,
        directory: "/workspace",
        message: { type: "requestAdmin", requestID },
        host: { voice: () => ({ available: true, active: 0, failed, incomplete }) },
        post: (message) => posts.push(message),
      })
      return (posts.pop() as { health: typeof health }).health.items.find((item) => item.id === "voice")
    }

    expect(await read("req_failed", 1, 1)).toEqual({
      id: "voice",
      status: "degraded",
      reason: "voice-failed",
      observedAt: 35,
      metrics: { active: 0, failed: 1, incomplete: 1 },
    })
    expect(await read("req_incomplete", 0, 1)).toEqual({
      id: "voice",
      status: "degraded",
      reason: "voice-incomplete",
      observedAt: 35,
      metrics: { active: 0, failed: 0, incomplete: 1 },
    })
  })
})
