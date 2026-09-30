import type { KiloClient } from "@kilocode/sdk/v2/client"
import type { ServerConfig } from "./types"

type Connection = { client: KiloClient; config: ServerConfig }
type Feature = "client.vscode" | "client.cli" | "client.console" | "events.additive" | "goal.commandCheck"
type Manifest = { version: 1; features: Record<string, unknown> }
type Outcome = { kind: "manifest"; manifest: Manifest } | { kind: "unsupported" } | { kind: "unavailable" }

// Client identity is the connection generation. A replacement at the same URL
// must never inherit a cached semantic guarantee from the previous process.
export class Capabilities {
  private readonly cache = new WeakMap<KiloClient, Promise<Outcome>>()

  constructor(
    private readonly current: () => Connection | undefined,
    private readonly failure?: (error: unknown) => void,
  ) {}

  async command(client: KiloClient): Promise<() => boolean> {
    return this.require(client, "goal.commandCheck")
  }

  async require(client: KiloClient, feature: Feature): Promise<() => boolean> {
    return (await this.probe(client, feature)).permit
  }

  async probe(client: KiloClient, feature: Feature) {
    const connection = this.current()
    if (!connection || connection.client !== client) return { status: "unavailable" as const, permit: () => false }
    const pending = this.cache.get(client) ?? this.read(connection.config)
    this.cache.set(client, pending)
    const outcome = await pending
    const supported = outcome.kind === "manifest" && outcome.manifest.features[feature] === 1
    // Failed or unsupported probes can be retried after connectivity or the backend is restored.
    if (!supported) this.cache.delete(client)
    const current = this.current()?.client === client
    const status =
      !current || outcome.kind === "unavailable"
        ? ("unavailable" as const)
        : supported
          ? ("supported" as const)
          : ("unsupported" as const)
    return { status, permit: () => supported && this.current()?.client === client }
  }

  private manifest(value: unknown): Outcome {
    if (
      !value ||
      typeof value !== "object" ||
      !("version" in value) ||
      typeof value.version !== "number" ||
      !Number.isSafeInteger(value.version) ||
      value.version < 1 ||
      !("features" in value) ||
      !value.features ||
      typeof value.features !== "object" ||
      Array.isArray(value.features)
    ) {
      this.failure?.({ code: "INVALID_MANIFEST" })
      return { kind: "unavailable" }
    }
    if (value.version !== 1) {
      this.failure?.({ code: "UNSUPPORTED_MANIFEST_VERSION" })
      return { kind: "unsupported" }
    }
    return { kind: "manifest", manifest: { version: 1, features: Object.fromEntries(Object.entries(value.features)) } }
  }

  private async read(config: ServerConfig): Promise<Outcome> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    try {
      const response = await fetch(`${config.baseUrl}/kilocode/capabilities`, {
        headers: { Authorization: `Basic ${Buffer.from(`kilo:${config.password}`).toString("base64")}` },
        signal: controller.signal,
        redirect: "error",
      })
      if (!response.ok) {
        this.failure?.({ status: response.status })
        return { kind: "unavailable" }
      }
      return this.manifest(await response.json())
    } catch (error) {
      this.failure?.({
        code: controller.signal.aborted
          ? "CAPABILITIES_TIMEOUT"
          : error instanceof SyntaxError
            ? "INVALID_MANIFEST"
            : "CAPABILITIES_TRANSPORT_FAILED",
      })
      // Connectivity never grants support; only a valid manifest can admit the client.
      return { kind: "unavailable" }
    } finally {
      clearTimeout(timer)
    }
  }
}
