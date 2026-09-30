import type { ExtensionMessage } from "../types/messages"

export type ProviderLoading = {
  status: "loading" | "ready" | "error" | "disconnected"
  generation: number
  disconnected: boolean
}

export function providerRetry(state: ProviderLoading): "retryConnection" | "requestProviders" | undefined {
  if (state.status === "loading") return
  return state.status === "disconnected" ? "retryConnection" : "requestProviders"
}

export function providerLoading(state: ProviderLoading, message: ExtensionMessage): ProviderLoading {
  if (message.type === "connectionState") {
    if (message.state !== "connected") {
      return {
        ...state,
        status: "disconnected",
        generation: state.generation + (state.disconnected ? 0 : 1),
        disconnected: true,
      }
    }
    if (!state.disconnected) return state
    return { ...state, status: "loading", disconnected: false }
  }
  if (message.type !== "providersLoaded" && message.type !== "providersLoadState") return state
  const generation = message.generation ?? 0
  if (generation < state.generation) return state
  if (state.disconnected) return { ...state, status: "disconnected", generation }
  return {
    status: message.type === "providersLoaded" ? "ready" : message.state,
    generation,
    disconnected: false,
  }
}
