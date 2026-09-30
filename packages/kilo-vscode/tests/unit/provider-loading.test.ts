import { describe, expect, it } from "bun:test"
import { providerLoading, providerRetry, type ProviderLoading } from "../../webview-ui/src/context/provider-loading"
import type { ProvidersLoadedMessage } from "../../webview-ui/src/types/messages"

const initial = (): ProviderLoading => ({ status: "loading", generation: 0, disconnected: false })
const loaded = (generation?: number): ProvidersLoadedMessage => ({
  type: "providersLoaded",
  generation,
  providers: {},
  connected: [],
  defaults: {},
  defaultSelection: { providerID: "kilo", modelID: "auto" },
  authMethods: {},
  authStates: {},
})

describe("provider loading", () => {
  it("retries the connection when disconnected and the catalog after a load failure", () => {
    const disconnected = providerLoading(initial(), { type: "connectionState", state: "error" })
    expect(providerRetry(disconnected)).toBe("retryConnection")
    expect(providerRetry(initial())).toBeUndefined()
    const connected = providerLoading(disconnected, { type: "connectionState", state: "connected" })
    expect(providerRetry(connected)).toBeUndefined()
    const failed = providerLoading(connected, { type: "providersLoadState", state: "error", generation: 2 })
    expect(providerRetry(failed)).toBe("requestProviders")
  })

  it("recovers a cold disconnected catalog through connection retry and the host readiness refresh", () => {
    const disconnected = providerLoading(initial(), { type: "connectionState", state: "disconnected" })
    expect(providerRetry(disconnected)).toBe("retryConnection")
    const connecting = providerLoading(disconnected, { type: "connectionState", state: "connecting" })
    expect(connecting.status).toBe("disconnected")
    const connected = providerLoading(connecting, { type: "connectionState", state: "connected" })
    expect(connected.status).toBe("loading")
    const refreshing = providerLoading(connected, { type: "providersLoadState", state: "loading", generation: 2 })
    expect(providerLoading(refreshing, loaded(2)).status).toBe("ready")
  })

  it("accepts a successful empty catalog only after completion", () => {
    const state = providerLoading(initial(), { type: "providersLoadState", state: "loading", generation: 1 })
    expect(state.status).toBe("loading")
    expect(providerLoading(state, loaded(1)).status).toBe("ready")
  })

  it("rejects stale success, failure and legacy responses after a newer request", () => {
    const state = providerLoading(initial(), { type: "providersLoadState", state: "loading", generation: 3 })
    expect(providerLoading(state, loaded(2))).toBe(state)
    expect(providerLoading(state, loaded())).toBe(state)
    expect(providerLoading(state, { type: "providersLoadState", state: "error", generation: 2 })).toBe(state)
    const failed = providerLoading(state, {
      type: "providersLoadState",
      state: "error",
      generation: 3,
      error: "sensitive internal error",
    })
    expect(failed.status).toBe("error")
    expect(failed).not.toHaveProperty("error")
  })

  it("keeps cached success unavailable during disconnect and waits for current reconnect refresh", () => {
    const ready = providerLoading(initial(), loaded(4))
    const disconnected = providerLoading(ready, { type: "connectionState", state: "disconnected" })
    expect(disconnected.status).toBe("disconnected")
    expect(providerLoading(disconnected, loaded(4)).status).toBe("disconnected")
    const connected = providerLoading(disconnected, { type: "connectionState", state: "connected" })
    expect(connected.status).toBe("loading")
    expect(providerLoading(connected, loaded(4))).toBe(connected)
    const refreshing = providerLoading(connected, { type: "providersLoadState", state: "loading", generation: 5 })
    expect(providerLoading(refreshing, loaded(4))).toBe(refreshing)
    expect(providerLoading(refreshing, loaded(5)).status).toBe("ready")
  })

  it("accepts a readiness refresh when the initial request was dropped", () => {
    const connecting = providerLoading(initial(), { type: "connectionState", state: "connecting" })
    const connected = providerLoading(connecting, { type: "connectionState", state: "connected" })
    const refreshing = providerLoading(connected, { type: "providersLoadState", state: "loading", generation: 1 })
    expect(providerLoading(refreshing, loaded(1)).status).toBe("ready")
  })

  it("supports legacy successful fixture responses before generation messages", () => {
    expect(providerLoading(initial(), loaded()).status).toBe("ready")
  })
})
