// raya_change - Milestone F testable CLI-to-Playwright browser bridge
import type {
  BrowserFailure,
  BrowserRequest,
  BrowserResult as HostBrowserResult,
  EventKilocodeBrowserCancelled,
  EventKilocodeBrowserRequested,
  KiloClient,
} from "@kilocode/sdk/v2/client"
import type { SSEPayload } from "../cli-backend/sdk-sse-adapter"
import type { ConnectionState } from "../cli-backend/connection-service"
import type { BrowserAction, BrowserResult } from "./browser-session"

export interface BrowserConnection {
  onEvent(listener: (event: SSEPayload, directory?: string) => void): () => void
  onStateChange(listener: (state: ConnectionState, error?: Error) => void): () => void
  getKnownDirectories(): string[]
  getClient(): KiloClient
}

export interface BrowserHost {
  show(): Promise<void>
  execute(action: BrowserAction): Promise<BrowserResult>
  cancel?(): void
}

function action(request: BrowserRequest): BrowserAction {
  if (request.operation !== "scroll") return request
  const x = Number(request.deltaX)
  const y = Number(request.deltaY)
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Browser scroll deltas must be finite numbers")
  return { operation: "scroll", deltaX: x, deltaY: y, selector: request.selector }
}

export class BrowserBridge {
  private readonly active = new Map<string, AbortController>()
  private readonly offEvent: () => void
  private readonly offState: () => void
  private revision = 0
  private disposed = false

  constructor(
    private readonly connection: BrowserConnection,
    private readonly host: BrowserHost,
  ) {
    this.offEvent = connection.onEvent((event, directory) => this.event(event, directory))
    this.offState = connection.onStateChange((state) => this.state(state))
  }

  private event(event: SSEPayload, directory?: string): void {
    const value = event as unknown as EventKilocodeBrowserRequested | EventKilocodeBrowserCancelled
    if (value.type === "kilocode.browser.cancelled") {
      const controller = this.active.get(value.properties.requestID)
      controller?.abort()
      this.active.delete(value.properties.requestID)
      if (controller) this.host.cancel?.()
      return
    }
    if (value.type !== "kilocode.browser.requested" || !directory || this.active.has(value.properties.id)) return
    void this.run(value.properties, directory)
  }

  private state(state: ConnectionState): void {
    if (state !== "connected") return
    const revision = ++this.revision
    void this.recover(revision)
  }

  private async recover(revision: number): Promise<void> {
    for (const directory of this.connection.getKnownDirectories()) {
      if (this.disposed || revision !== this.revision) return
      const response = await this.connection.getClient().kilocode.browser.list({ directory })
      if (response.error) {
        console.error("[Kilo New] BrowserBridge: request recovery failed:", response.error)
        continue
      }
      for (const request of response.data ?? []) {
        if (this.active.has(request.id)) continue
        void this.run(request, directory)
      }
    }
  }

  private async run(request: BrowserRequest, directory: string): Promise<void> {
    const controller = new AbortController()
    this.active.set(request.id, controller)
    try {
      await this.host.show()
      if (controller.signal.aborted) return
      const result = await this.host.execute(action(request))
      if (controller.signal.aborted) return
      const response = await this.connection.getClient().kilocode.browser.reply({
        requestID: request.id,
        directory,
        result: result as HostBrowserResult,
      })
      if (response.error) throw new Error(String(response.error))
    } catch (error) {
      if (controller.signal.aborted) return
      const message = error instanceof Error ? error.message : String(error)
      console.error("[Kilo New] BrowserBridge: browser request failed:", error)
      const failure: BrowserFailure = {
        code:
          request.operation === "navigate"
            ? "navigation_failed"
            : request.operation === "evaluate"
              ? "evaluation_failed"
              : "invalid_request",
        message: message.slice(0, 10_000),
      }
      await this.connection.getClient().kilocode.browser.reject({
        requestID: request.id,
        directory,
        error: failure,
      })
    } finally {
      this.active.delete(request.id)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.revision += 1
    this.offEvent()
    this.offState()
    for (const controller of this.active.values()) controller.abort()
    this.active.clear()
  }
}
