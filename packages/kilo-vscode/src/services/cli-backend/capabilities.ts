import type { KiloClient } from "@kilocode/sdk/v2/client"
import type { ServerConfig } from "./types"

type Connection = { client: KiloClient; config: ServerConfig }

// Client identity is the connection generation. A replacement at the same URL
// must never inherit a cached semantic guarantee from the previous process.
export class Capabilities {
  private readonly cache = new WeakMap<KiloClient, Promise<boolean>>()

  constructor(private readonly current: () => Connection | undefined) {}

  async command(client: KiloClient): Promise<() => boolean> {
    const connection = this.current()
    if (!connection || connection.client !== client) return () => false
    const pending = this.cache.get(client) ?? this.read(connection.config)
    this.cache.set(client, pending)
    const supported = await pending
    // Failed probes can be retried after connectivity is restored.
    if (!supported) this.cache.delete(client)
    return () => supported && this.current()?.client === client
  }

  private async read(config: ServerConfig): Promise<boolean> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    try {
      const response = await fetch(`${config.baseUrl}/kilocode/capabilities`, {
        headers: { Authorization: `Basic ${Buffer.from(`kilo:${config.password}`).toString("base64")}` },
        signal: controller.signal,
        redirect: "error",
      })
      if (!response.ok) return false
      const value: unknown = await response.json()
      return (
        !!value &&
        typeof value === "object" &&
        "version" in value &&
        value.version === 1 &&
        "features" in value &&
        !!value.features &&
        typeof value.features === "object" &&
        "goal.commandCheck" in value.features &&
        value.features["goal.commandCheck"] === 1
      )
    } catch {
      // The caller receives an explicit compatibility failure; never mutate to probe support.
      return false
    } finally {
      clearTimeout(timer)
    }
  }
}
