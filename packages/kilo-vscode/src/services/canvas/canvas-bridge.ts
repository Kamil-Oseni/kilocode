// raya_change - Milestone E testable CLI-to-extension canvas bridge
import type {
  CanvasFailure,
  CanvasRequest,
  CanvasResult,
  EventKilocodeCanvasCancelled,
  EventKilocodeCanvasRequested,
  KiloClient,
} from "@kilocode/sdk/v2/client"
import type { SSEPayload } from "../cli-backend/sdk-sse-adapter"
import type { ConnectionState } from "../cli-backend/connection-service"

export interface CanvasConnection {
  onEvent(listener: (event: SSEPayload, directory?: string) => void): () => void
  onStateChange(listener: (state: ConnectionState, error?: Error) => void): () => void
  getKnownDirectories(): string[]
  getClient(): KiloClient
}

export interface CanvasHost {
  execute(request: CanvasRequest, directory: string): Promise<CanvasResult>
  cancel?(): void
}

export class CanvasBridge {
  private readonly active = new Map<string, AbortController>()
  private readonly offEvent: () => void
  private readonly offState: () => void
  private revision = 0
  private disposed = false

  constructor(
    private readonly connection: CanvasConnection,
    private readonly host: CanvasHost,
  ) {
    this.offEvent = connection.onEvent((event, directory) => this.event(event, directory))
    this.offState = connection.onStateChange((state) => this.state(state))
  }

  private event(event: SSEPayload, directory?: string): void {
    const value = event as unknown as EventKilocodeCanvasRequested | EventKilocodeCanvasCancelled
    if (value.type === "kilocode.canvas.cancelled") {
      const controller = this.active.get(value.properties.requestID)
      controller?.abort()
      this.active.delete(value.properties.requestID)
      if (controller) this.host.cancel?.()
      return
    }
    if (value.type !== "kilocode.canvas.requested") return
    // raya_change - a canvas request with no directory (or an already-active id) can never be
    // answered, and the backend then waits out its full two-minute host timeout. Log the drop
    // instead of silently returning so the cause is visible in the next diagnostic run.
    if (!directory || this.active.has(value.properties.id)) {
      console.warn(
        "[Kilo New] CanvasBridge: dropping canvas request",
        value.properties.id,
        !directory ? "(no directory)" : "(already active)",
      )
      return
    }
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
      const response = await this.connection.getClient().kilocode.canvas.list({ directory })
      if (response.error) {
        console.error("[Kilo New] CanvasBridge: request recovery failed:", response.error)
        continue
      }
      for (const request of response.data ?? []) {
        if (this.active.has(request.id)) continue
        void this.run(request, directory)
      }
    }
  }

  private async run(request: CanvasRequest, directory: string): Promise<void> {
    const controller = new AbortController()
    this.active.set(request.id, controller)
    try {
      console.log("[Kilo New] CanvasBridge: handling", request.operation, request.name, "in", directory)
      const result = await this.host.execute(request, directory)
      if (controller.signal.aborted) return
      const response = await this.connection.getClient().kilocode.canvas.reply({
        requestID: request.id,
        directory,
        result,
      })
      if (response.error) throw new Error(String(response.error))
      console.log("[Kilo New] CanvasBridge: replied", request.name, result.status)
    } catch (error) {
      if (controller.signal.aborted) return
      const message = error instanceof Error ? error.message : String(error)
      console.error("[Kilo New] CanvasBridge: canvas request failed:", error)
      const failure: CanvasFailure = {
        code: request.operation === "update" && /ENOENT|not found/i.test(message) ? "not_found" : "invalid_request",
        message: message.slice(0, 100_000),
      }
      // raya_change - surface a failed rejection too; if neither reply nor reject reaches the
      // backend the host sits idle until its two-minute timeout, so a broken reply channel must
      // be visible rather than swallowed.
      const rejected = await this.connection.getClient().kilocode.canvas.reject({
        requestID: request.id,
        directory,
        error: failure,
      })
      if (rejected.error) console.error("[Kilo New] CanvasBridge: canvas reject also failed:", rejected.error)
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
