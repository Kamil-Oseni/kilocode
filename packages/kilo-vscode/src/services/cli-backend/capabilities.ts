import type { KiloClient } from "@kilocode/sdk/v2/client"
import type { ServerConfig } from "./types"

type Connection = { client: KiloClient; config: ServerConfig }
type Feature = "client.vscode" | "client.cli" | "client.console" | "events.additive" | "goal.commandCheck"
type Manifest = { version: 1; features: Record<string, unknown> }

// Client identity is the connection generation. A replacement at the same URL
// must never inherit a cached semantic guarantee from the previous process.
export class Capabilities {
  private readonly cache = new WeakMap<KiloClient, Promise<Manifest | undefined>>()

  constructor(private readonly current: () => Connection | undefined) {}

  async command(client: KiloClient): Promise<() => boolean> {
    return this.require(client, "goal.commandCheck")
  }

  async require(client: KiloClient, feature: Feature): Promise<() => boolean> {
    const connection = this.current()
    if (!connection || connection.client !== client) return () => false
    const pending = this.cache.get(client) ?? this.read(connection.config)
    this.cache.set(client, pending)
    const manifest = await pending
    const supported = manifest?.features[feature] === 1
    // Failed or unsupported probes can be retried after connectivity or the backend is restored.
    if (!supported) this.cache.delete(client)
    return () => supported && this.current()?.client === client
  }

  private async read(config: ServerConfig): Promise<Manifest | undefined> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    try {
      const response = await fetch(`${config.baseUrl}/kilocode/capabilities`, {
        headers: { Authorization: `Basic ${Buffer.from(`kilo:${config.password}`).toString("base64")}` },
        signal: controller.signal,
        redirect: "error",
      })
      if (!response.ok) return undefined
      const value: unknown = await response.json()
      if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1) return undefined
      if (!("features" in value) || !value.features || typeof value.features !== "object") return undefined
      return { version: 1, features: Object.fromEntries(Object.entries(value.features)) }
    } catch {
      // The caller receives an explicit compatibility failure; never mutate to probe support.
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }
}
