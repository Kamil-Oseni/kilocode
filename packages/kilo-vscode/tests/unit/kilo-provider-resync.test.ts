import { expect, test } from "bun:test"

// The shared preload supplies the VS Code host boundary.
const { KiloProvider } = await import("../../src/KiloProvider")

test("one overflow transition causes one routine replay and one projection reconciliation", async () => {
  let state: ((value: "connecting" | "connected") => Promise<void>) | undefined
  const noop = () => () => undefined
  const service = {
    connect: async () => undefined,
    getClient: () => ({}),
    onEventFiltered: noop,
    onStateChange: (listener: typeof state) => {
      state = listener
      return () => undefined
    },
    onNotificationDismissed: noop,
    onClearPendingPrompts: noop,
    onLanguageChanged: noop,
    onProfileChanged: noop,
    onMigrationComplete: noop,
    onFavoritesChanged: noop,
    onModelSelectorExpandedChanged: noop,
    registerDirectoryProvider: noop,
    getServerInfo: () => null,
    getConnectionState: () => "connected" as const,
    getConnectionError: () => null,
  }
  const provider = new KiloProvider({} as never, service as never)
  const internal = provider as unknown as {
    initializeConnection: () => Promise<void>
    routineEvents: { recover: () => Promise<void>; invalidate: () => void }
    reconcileAfterReconnect: () => Promise<void>
    syncWebviewState: () => Promise<void>
    flushPendingSessionRefresh: () => Promise<void>
    recoverPendingPrompts: () => void
    checkConfigWarnings: () => Promise<void>
    fetchAndSendProviders: () => Promise<void>
    fetchAndSendAgents: () => Promise<void>
    fetchAndSendSkills: () => Promise<void>
    fetchAndSendCommands: () => Promise<void>
    fetchAndSendConfig: () => Promise<void>
    fetchAndSendNotifications: () => Promise<void>
    seedSessionStatusMap: () => Promise<void>
    sendNotificationSettings: () => void
    startStatsPolling: () => void
  }
  let replay = 0
  let reconcile = 0
  let sync = 0
  internal.routineEvents.recover = async () => {
    replay++
  }
  internal.reconcileAfterReconnect = async () => {
    reconcile++
  }
  internal.syncWebviewState = async () => {
    sync++
  }
  internal.flushPendingSessionRefresh = async () => undefined
  internal.recoverPendingPrompts = () => undefined
  internal.checkConfigWarnings = async () => undefined
  internal.fetchAndSendProviders = async () => undefined
  internal.fetchAndSendAgents = async () => undefined
  internal.fetchAndSendSkills = async () => undefined
  internal.fetchAndSendCommands = async () => undefined
  internal.fetchAndSendConfig = async () => undefined
  internal.fetchAndSendNotifications = async () => undefined
  internal.seedSessionStatusMap = async () => undefined
  internal.sendNotificationSettings = () => undefined
  internal.startStatsPolling = () => undefined

  await internal.initializeConnection()
  expect(state).toBeDefined()
  sync = 0
  await state!("connecting")
  await state!("connected")
  expect(replay).toBe(1)
  expect(reconcile).toBe(1)
  expect(sync).toBe(1)
})
