import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { DraftTarget } from "../../src/shared/composer-drafts-messages"

const { KiloProvider } = await import("../../src/KiloProvider")

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "raya-profile-startup-"))
  let release!: () => void
  const held = new Promise<void>((done) => (release = done))
  const requests: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const route = new URL(request.url).pathname
      requests.push(route)
      if (route === "/kilo/profile") {
        await held
        return Response.json({ fixture: "late-profile" })
      }
      if (route === "/agent") return Response.json([])
      if (route === "/session/status") return Response.json({})
      if (route === "/project/current") return Response.json({ id: "private-project", worktree: root })
      if (route === "/global/config") return Response.json({ model: "private/local" })
      return Response.json({})
    },
  })
  const client = createKiloClient({ baseUrl: server.url.origin })
  const state = { client }
  const noop = () => () => undefined
  // Only the editor/connection boundary is controlled; sync and SDK HTTP calls are real.
  const service = {
    getServerInfo: () => null,
    getClient: () => state.client,
    getConnectionState: () => "connected",
    getConnectionError: () => null,
    onStateChange: noop,
    registerDirectoryProvider: noop,
  }
  const provider = new KiloProvider({} as never, service as never, undefined, {
    projectDirectory: root,
    rootDirectory: () => root,
  })
  const messages: Array<{ type: string; data?: unknown }> = []
  const internal = provider as unknown as {
    connectionState: string
    connectionGeneration: number
    isWebviewReady: boolean
    postMessage: (message: (typeof messages)[number]) => void
    syncWebviewState: (reason: string) => Promise<void>
    fetchAndSendAgents: () => Promise<void>
    fetchAndSendGlobalConfig: () => Promise<void>
    seedSessionStatusMap: () => Promise<void>
    composerScope: (target: DraftTarget) => Promise<unknown>
  }
  internal.connectionState = "connected"
  internal.isWebviewReady = true
  internal.postMessage = (message) => messages.push(message)
  return {
    internal,
    client,
    state,
    messages,
    requests,
    release,
    async close() {
      release()
      server.stop(true)
      await rm(root, { recursive: true, force: true })
    },
  }
}

test("real webview sync leaves optional profile HTTP pending while local startup proceeds", async () => {
  const f = await fixture()
  try {
    const synced = f.internal.syncWebviewState("private-startup")
    expect(await Promise.race([synced.then(() => true), Bun.sleep(250).then(() => false)])).toBe(true)
    await Promise.all([
      f.internal.fetchAndSendAgents(),
      f.internal.fetchAndSendGlobalConfig(),
      f.internal.seedSessionStatusMap(),
      f.internal.composerScope({ box: "sidebar:new-task", key: "private-pending", pendingID: "private" }),
    ])
    expect(f.requests).toContain("/kilo/profile")
    expect(f.requests).toContain("/agent")
    expect(f.requests).toContain("/global/config")
    expect(f.requests).toContain("/session/status")
    expect(f.requests).toContain("/project/current")
    expect(f.messages.some((message) => message.type === "agentsLoaded")).toBe(true)
    expect(f.messages.some((message) => message.type === "globalConfigLoaded")).toBe(true)
    expect(f.messages.some((message) => message.type === "profileData")).toBe(false)
    f.release()
    await Bun.sleep(25)
    expect(f.messages.filter((message) => message.type === "profileData")).toEqual([
      { type: "profileData", data: { fixture: "late-profile" } },
    ])
  } finally {
    await f.close()
  }
})

for (const change of ["client", "generation"] as const)
  test(`late optional profile cannot update a replacement ${change}`, async () => {
    const f = await fixture()
    try {
      await f.internal.syncWebviewState("private-stale")
      await Bun.sleep(10)
      if (change === "client") f.state.client = createKiloClient({ baseUrl: "http://127.0.0.1:1" })
      if (change === "generation") f.internal.connectionGeneration++
      f.release()
      await Bun.sleep(25)
      expect(f.messages.some((message) => message.type === "profileData")).toBe(false)
    } finally {
      await f.close()
    }
  })
