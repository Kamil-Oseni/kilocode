import { expect, test } from "bun:test"
import type { SSEPayload } from "../../src/services/cli-backend/sdk-sse-adapter"

const { KiloProvider } = await import("../../src/KiloProvider")
type State = "connecting" | "connected" | "disconnected" | "error"
type Data = {
  data: {
    all: Array<{ id: string; name: string; models: Record<string, never> }>
    connected: string[]
    default: Record<string, string>
  }
}
const data = (id: string): Data => ({ data: { all: [{ id, name: id, models: {} }], connected: [id], default: {} } })
function gate<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function fixture(list: (input?: { directory?: string }) => Promise<Data>) {
  const listeners = new Set<(state: State, err?: Error) => Promise<void>>()
  const events = new Set<(event: SSEPayload, directory?: string) => void>()
  const messages: Array<{
    type: string
    state?: string
    generation?: number
    error?: string
    connected?: string[]
    message?: { id?: string }
  }> = []
  const client = {
    provider: { list, auth: async () => ({ data: {} }) },
    kilo: { authStatus: async () => ({ data: { authenticated: false } }) },
  }
  const status = { connected: true, subscriptions: 0, connects: 0, observed: false }
  const noop = () => () => undefined
  const service = {
    connect: async (): Promise<void> => {
      status.connects++
      throw new Error("controlled startup failure")
    },
    getClient: () => {
      if (!status.connected) throw new Error("disconnected")
      return client
    },
    getConnectionError: () => null,
    getConnectionState: () => (status.connected ? "connected" : "disconnected"),
    getServerInfo: () => null,
    onEventFiltered: (
      filter: (event: SSEPayload, directory?: string) => boolean,
      listener: (event: SSEPayload, directory?: string) => void,
    ) => {
      status.observed = true
      const wrapped = (event: SSEPayload, directory?: string) => {
        if (filter(event, directory)) listener(event, directory)
      }
      events.add(wrapped)
      return () => {
        events.delete(wrapped)
        status.observed = events.size > 0
      }
    },
    onNotificationDismissed: noop,
    onClearPendingPrompts: noop,
    onLanguageChanged: noop,
    onProfileChanged: noop,
    onMigrationComplete: noop,
    onFavoritesChanged: noop,
    onModelSelectorExpandedChanged: noop,
    registerDirectoryProvider: noop,
    unregisterVisible: () => undefined,
    unregisterAttached: () => undefined,
    registerVisible: () => undefined,
    registerAttached: () => undefined,
    recordMessageSessionId: () => undefined,
    onStateChange: (listener: (state: State, err?: Error) => Promise<void>) => {
      status.subscriptions++
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  // Controlled VS Code/service boundary; the production provider methods below remain real.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const provider = new KiloProvider({} as never, service as never, undefined, { projectDirectory: "C:\\draft-one" })
  // Expose private lifecycle methods solely to exercise host posts and subscription ownership.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const internal = provider as unknown as {
    initializeConnection: () => Promise<void>
    subscribeConnection: () => void
    fetchAndSendProviders: () => Promise<void>
    connectionGeneration: number
    connectionState: State
    providersRefresh: Promise<void> | null
    postMessage: (message: (typeof messages)[number]) => void
    syncWebviewState: () => Promise<void>
    flushPendingSessionRefresh: () => Promise<void>
    recoverPendingPrompts: () => void
    checkConfigWarnings: () => Promise<void>
    reconcileAfterReconnect: () => Promise<void>
    routineEvents: { recover: () => Promise<void> }
    fetchAndSendAgents: () => Promise<void>
    fetchAndSendSkills: () => Promise<void>
    fetchAndSendCommands: () => Promise<void>
    fetchAndSendConfig: () => Promise<void>
    fetchAndSendIndexingStatus: () => Promise<void>
    fetchAndSendNotifications: () => Promise<void>
    seedSessionStatusMap: () => Promise<void>
    refreshGitStatus: () => Promise<void>
    sendNotificationSettings: () => void
    sendTimelineSetting: () => void
    memory: { fetch: () => Promise<void> }
    trackedSessionIds: Set<string>
  }
  internal.postMessage = (message) => {
    messages.push(message)
  }
  internal.syncWebviewState = async () => undefined
  internal.flushPendingSessionRefresh = async () => undefined
  internal.recoverPendingPrompts = () => undefined
  internal.checkConfigWarnings = async () => undefined
  internal.reconcileAfterReconnect = async () => undefined
  internal.routineEvents.recover = async () => undefined
  internal.fetchAndSendAgents = async () => undefined
  internal.fetchAndSendSkills = async () => undefined
  internal.fetchAndSendCommands = async () => undefined
  internal.fetchAndSendConfig = async () => undefined
  internal.fetchAndSendIndexingStatus = async () => undefined
  internal.fetchAndSendNotifications = async () => undefined
  internal.seedSessionStatusMap = async () => undefined
  internal.refreshGitStatus = async () => undefined
  internal.sendNotificationSettings = () => undefined
  internal.sendTimelineSetting = () => undefined
  internal.memory.fetch = async () => undefined
  const emit = async (state: State) => {
    status.connected = state === "connected"
    await Promise.all([...listeners].map((listener) => listener(state)))
  }
  return { provider, service, internal, messages, status, emit, listeners, events }
}

test("failed initial Settings connection retains exactly one listener and reconnect refreshes before optional profile sync", async () => {
  let reads = 0
  const ctx = fixture(async () => {
    reads++
    return data("local")
  })
  ctx.status.connected = false
  await ctx.internal.initializeConnection()
  await ctx.internal.initializeConnection()
  expect(ctx.status.connects).toBe(2)
  expect(ctx.status.subscriptions).toBe(1)
  expect(ctx.listeners.size).toBe(1)
  const profile = gate<void>()
  ctx.internal.syncWebviewState = () => profile.promise
  const pending = ctx.emit("connected")
  try {
    await ctx.internal.providersRefresh
    expect(reads).toBe(1)
    expect(ctx.messages.filter((item) => item.type === "providersLoaded").map((item) => item.connected)).toEqual([
      ["local"],
    ])
    expect(ctx.messages.some((item) => item.type === "providersLoadState" && item.state === "loading")).toBe(true)
  } finally {
    profile.resolve()
    await pending
  }
  await ctx.emit("connected")
  expect(reads).toBe(1)
  expect(ctx.status.connects).toBe(2)
})

for (const rejected of [false, true])
  test(`coalesced discovery ignores stale ${rejected ? "failure" : "success"} and publishes the latest generation`, async () => {
    const first = gate<Data>()
    let reads = 0
    const ctx = fixture(() => (++reads === 1 ? first.promise : Promise.resolve(data("latest"))))
    const old = ctx.internal.fetchAndSendProviders()
    const next = ctx.internal.fetchAndSendProviders()
    if (rejected) first.reject(new Error("fixture credential must never reach UI"))
    if (!rejected) first.resolve(data("old"))
    await Promise.all([old, next])
    expect(reads).toBe(2)
    expect(ctx.messages.filter((item) => item.type === "providersLoaded")).toEqual([
      expect.objectContaining({ generation: 2, connected: ["latest"] }),
    ])
    expect(ctx.messages.filter((item) => item.type === "providersLoadState" && item.state === "error")).toHaveLength(0)
    expect(JSON.stringify(ctx.messages)).not.toContain("fixture credential")
  })

test("connection generation invalidates an in-flight result even with the same SDK client", async () => {
  const first = gate<Data>()
  const ctx = fixture(() => first.promise)
  const pending = ctx.internal.fetchAndSendProviders()
  ctx.internal.connectionGeneration++
  first.resolve(data("stale"))
  await pending
  expect(ctx.messages.some((item) => item.type === "providersLoaded")).toBe(false)
})

test("disconnected and failed discovery publish only sanitized current errors, never cached success", async () => {
  const ctx = fixture(async () => {
    throw new Error("private provider key fixture")
  })
  await ctx.internal.fetchAndSendProviders()
  ctx.status.connected = false
  await ctx.internal.fetchAndSendProviders()
  expect(ctx.messages.filter((item) => item.type === "providersLoaded")).toHaveLength(0)
  expect(ctx.messages.filter((item) => item.type === "providersLoadState" && item.state === "error")).toEqual([
    {
      type: "providersLoadState",
      state: "error",
      generation: 1,
      error: "Providers could not be loaded. Try again.",
    },
    {
      type: "providersLoadState",
      state: "error",
      generation: 2,
      error: "Providers could not be loaded. Try again.",
    },
  ])
  expect(JSON.stringify(ctx.messages)).not.toContain("private provider key")
})

test("early connected discovery cannot recover prompts before acceptance-event observation", async () => {
  const ctx = fixture(async () => data("local"))
  let recovered = 0
  ctx.internal.recoverPendingPrompts = () => {
    expect(ctx.status.observed).toBe(true)
    recovered++
  }
  ctx.service.connect = async () => {
    ctx.status.connects++
    expect(ctx.status.observed).toBe(true)
    await ctx.emit("connected")
    expect(ctx.status.observed).toBe(true)
    expect(recovered).toBe(0)
  }
  await ctx.internal.initializeConnection()
  expect(recovered).toBe(1)
  expect(ctx.status.observed).toBe(true)
  expect(ctx.status.subscriptions).toBe(1)
  expect(ctx.messages.some((item) => item.type === "providersLoaded")).toBe(true)
})

test("failed startup retains one full event observer and an external reconnect forwards user-message acceptance", async () => {
  const ctx = fixture(async () => data("local"))
  ctx.status.connected = false
  await ctx.internal.initializeConnection()
  await ctx.internal.initializeConnection()
  expect(ctx.events.size).toBe(1)
  expect(ctx.listeners.size).toBe(1)
  expect(ctx.status.observed).toBe(true)
  ctx.internal.trackedSessionIds.add("session-one")
  await ctx.emit("connected")
  const accepted: SSEPayload = {
    type: "sync",
    name: "message.updated.1",
    id: "event-one",
    seq: 1,
    aggregateID: "session-one",
    data: {
      sessionID: "session-one",
      info: {
        id: "message-one",
        sessionID: "session-one",
        role: "user",
        time: { created: 1 },
        agent: "chief",
        model: { providerID: "local", modelID: "tiny" },
      },
    },
  }
  for (const listener of ctx.events) listener(accepted, "C:\\draft-one")
  expect(ctx.messages.filter((item) => item.type === "messageCreated").map((item) => item.message?.id)).toEqual([
    "message-one",
  ])
  expect(ctx.status.connects).toBe(2)
  ctx.provider.dispose()
  expect(ctx.events.size).toBe(0)
  expect(ctx.listeners.size).toBe(0)
})

test("reconnect queues replacement discovery while an old request fails, retaining busy until replacement settles", async () => {
  const first = gate<Data>()
  const second = gate<Data>()
  const started = gate<void>()
  let reads = 0
  const ctx = fixture(() => {
    reads++
    if (reads === 1) return first.promise
    started.resolve()
    return second.promise
  })
  ctx.internal.connectionState = "connected"
  ctx.internal.subscribeConnection()
  const pending = ctx.internal.fetchAndSendProviders()
  await ctx.emit("connecting")
  await ctx.emit("connected")
  first.reject(new Error("old private failure"))
  await started.promise
  expect(reads).toBe(2)
  expect(ctx.internal.providersRefresh).not.toBeNull()
  expect(ctx.messages.some((item) => item.type === "providersLoaded" || item.state === "error")).toBe(false)
  second.resolve(data("replacement"))
  await pending
  expect(ctx.internal.providersRefresh).toBeNull()
  expect(ctx.messages.filter((item) => item.type === "providersLoaded")).toEqual([
    expect.objectContaining({ generation: 3, connected: ["replacement"] }),
  ])
})

test("actual project switch queues its new directory and never posts old catalog or clears replacement busy early", async () => {
  const first = gate<Data>()
  const second = gate<Data>()
  const started = gate<void>()
  const directories: Array<string | undefined> = []
  const ctx = fixture((input) => {
    directories.push(input?.directory)
    if (directories.length === 1) return first.promise
    started.resolve()
    return second.promise
  })
  const pending = ctx.internal.fetchAndSendProviders()
  ctx.provider.setProjectDirectory("C:\\draft-two")
  first.resolve(data("old-directory"))
  await started.promise
  expect(directories).toEqual(["C:\\draft-one", "C:\\draft-two"])
  expect(ctx.internal.providersRefresh).not.toBeNull()
  expect(ctx.messages.some((item) => item.type === "providersLoaded" || item.state === "error")).toBe(false)
  second.resolve(data("new-directory"))
  await pending
  expect(ctx.internal.providersRefresh).toBeNull()
  expect(ctx.messages.filter((item) => item.type === "providersLoaded")).toEqual([
    expect.objectContaining({ generation: 2, connected: ["new-directory"] }),
  ])
})
