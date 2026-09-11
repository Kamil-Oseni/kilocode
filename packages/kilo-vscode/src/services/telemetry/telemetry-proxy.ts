import * as vscode from "vscode"
import { TelemetryEventName, type TelemetryPropertiesProvider } from "./types"
import { buildTelemetryPayload, buildTelemetryAuthHeader } from "./telemetry-proxy-utils"

/**
 * Singleton proxy that captures telemetry events and forwards them to the CLI
 * server via POST /telemetry/capture. The CLI handles PostHog delivery.
 */
export class TelemetryProxy {
  private static singleton: TelemetryProxy | undefined

  private connection: { url: string; password: string; abort: AbortController } | undefined
  private pending = new Set<AbortController>()
  private provider: TelemetryPropertiesProvider | undefined

  private constructor() {}

  static getInstance(): TelemetryProxy {
    return (TelemetryProxy.singleton ??= new TelemetryProxy())
  }

  static capture(event: TelemetryEventName, properties?: Record<string, unknown>) {
    return TelemetryProxy.getInstance().capture(event, properties)
  }

  /**
   * Configure the CLI server connection. Must be called before capture() will send events.
   */
  configure(url: string, password: string) {
    this.disconnect()
    if (url && password) this.connection = { url, password, abort: new AbortController() }
  }

  disconnect() {
    this.connection?.abort.abort()
    this.connection = undefined
    for (const request of this.pending) request.abort()
    this.pending.clear()
  }

  setProvider(provider: TelemetryPropertiesProvider) {
    this.provider = provider
  }

  isVSCodeTelemetryEnabled(): boolean {
    return vscode.env.isTelemetryEnabled
  }

  /**
   * Capture with optional transport settlement. Enriches with provider properties, then POSTs to CLI.
   */
  async capture(event: TelemetryEventName, properties?: Record<string, unknown>) {
    if (!this.isVSCodeTelemetryEnabled()) return
    const connection = this.connection
    if (!connection || this.pending.size >= 32) return
    try {
      const payload = JSON.stringify(buildTelemetryPayload(event, properties, this.provider?.getTelemetryProperties()))
      if (this.connection !== connection || !this.isVSCodeTelemetryEnabled()) return
      await this.send(connection, "capture", payload)
    } catch {
      console.error("[Raya] Telemetry event preparation failed.")
    }
  }

  /**
   * Propagate runtime telemetry consent changes to the CLI. The CLI subprocess
   * reads `KILO_TELEMETRY_LEVEL` once at spawn — without this call, toggling
   * VS Code telemetry consent leaves the CLI's PostHog client stuck on its
   * spawn-time state until the process restarts.
   */
  async setEnabled(enabled: boolean) {
    const connection = this.connection
    if (!connection) return
    await this.send(connection, "setEnabled", JSON.stringify({ enabled }))
  }

  private async send(
    connection: NonNullable<TelemetryProxy["connection"]>,
    route: "capture" | "setEnabled",
    payload: string,
  ) {
    const abort = new AbortController()
    this.pending.add(abort)
    try {
      const response = await fetch(`${connection.url}/telemetry/${route}`, {
        method: "POST",
        headers: {
          Authorization: buildTelemetryAuthHeader(connection.password),
          "Content-Type": "application/json",
        },
        body: payload,
        redirect: "error",
        signal: AbortSignal.any([connection.abort.signal, abort.signal, AbortSignal.timeout(10_000)]),
      })
      await response.body?.cancel()
      if (!response.ok) throw new Error("Telemetry request refused")
    } catch {
      if (!connection.abort.signal.aborted && !abort.signal.aborted)
        console.error(`[Raya] Telemetry ${route} request failed.`)
    } finally {
      this.pending.delete(abort)
    }
  }

  /** Drop the endpoint and pending requests; the CLI owns PostHog shutdown. */
  shutdown() {
    this.disconnect()
    this.provider = undefined
  }
}
