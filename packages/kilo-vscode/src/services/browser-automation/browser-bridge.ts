// raya_change - Milestone F testable CLI-to-Playwright browser bridge
import { createHash } from "node:crypto"
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
  if (request.operation === "scroll") {
    const x = Number(request.deltaX)
    const y = Number(request.deltaY)
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Browser scroll deltas must be finite numbers")
    return { operation: "scroll", deltaX: x, deltaY: y, selector: request.selector }
  }
  // raya_change start - Milestone G validates generated special-number unions at the host boundary
  if (request.operation === "smoke")
    return {
      operation: "smoke",
      name: request.name,
      mode: request.mode,
      steps: request.steps.map((step) => ({
        ...step,
        assertions: step.assertions.map((assertion) => {
          if (assertion.kind === "visible") return assertion
          if (assertion.kind === "network") {
            const status = assertion.status === undefined ? undefined : Number(assertion.status)
            if (status !== undefined && !Number.isFinite(status))
              throw new Error(`Smoke step ${step.id} has an invalid network status`)
            return { ...assertion, status }
          }
          const max = Number(assertion.max)
          if (!Number.isFinite(max) || max < 0) throw new Error(`Smoke step ${step.id} has an invalid console maximum`)
          return { ...assertion, max }
        }),
      })),
    }
  // raya_change end
  return request
}

type Receipt = { fingerprint: string; result?: HostBrowserResult; failure?: BrowserFailure }

export class BrowserBridge {
  private readonly active = new Map<string, AbortController>()
  private readonly receipts = new Map<string, Receipt>()
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
    if (value.type !== "kilocode.browser.requested" || !directory) return
    void this.run(value.properties, directory)
  }

  private state(state: ConnectionState): void {
    if (state !== "connected") return
    const revision = ++this.revision
    void this.recover(revision).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error)
      console.error("[Raya] Browser request recovery read failed; no work replayed:", detail.slice(0, 1000))
    })
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
        void this.run(request, directory, true)
      }
    }
  }

  private async run(request: BrowserRequest, directory: string, recovered = false): Promise<void> {
    if (this.disposed) return
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([directory, request], (_key, value: unknown) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) return value
          return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
        }),
      )
      .digest("hex")
    const prior = this.receipts.get(request.id)
    if (prior && prior.fingerprint !== fingerprint) {
      await this.deliver(request.id, directory, {
        fingerprint,
        failure: {
          code: "invalid_request",
          message: "Browser request ID was reused with different content; no new action was dispatched.",
        },
      })
      return
    }
    if (this.active.has(request.id)) return
    if (prior) {
      await this.deliver(request.id, directory, prior)
      return
    }
    // Never evict a dispatched ID and later mistake it for new work. Capacity fails before dispatch.
    if (this.receipts.size >= 1024) {
      await this.deliver(request.id, directory, {
        fingerprint,
        failure: {
          code: "invalid_request",
          message:
            "Browser receipt capacity (1,024 requests) reached; this request was not dispatched. Reconnecting does not clear receipts. Review unresolved outcomes before intentionally reloading the extension. Reloading discards local receipts and cannot establish old outcomes.",
        },
      })
      return
    }
    const receipt: Receipt = {
      fingerprint,
      failure: {
        code: "cancelled",
        message:
          "This browser request was already admitted but its outcome is unconfirmed. It will not be dispatched again. Inspect the destination before repeating the action with a new request.",
      },
    }
    this.receipts.set(request.id, receipt)
    if (recovered) {
      receipt.failure = {
        code: "invalid_request",
        message:
          "Recovered browser request has no local execution receipt. Its prior outcome is unknown, so it was not replayed. Inspect the destination before issuing a fresh request.",
      }
      await this.deliver(request.id, directory, receipt)
      return
    }
    const controller = new AbortController()
    this.active.set(request.id, controller)
    const state = { completed: false }
    try {
      await this.host.show()
      if (controller.signal.aborted) return
      const result = (await this.host.execute(action(request))) as HostBrowserResult
      state.completed = true
      if (controller.signal.aborted) return
      if (Buffer.byteLength(JSON.stringify(result), "utf8") <= 64_000) {
        receipt.result = result
        receipt.failure = undefined
      } else {
        receipt.failure = {
          code: "invalid_request",
          message:
            "This browser request completed, but its result exceeds the retained receipt limit. It will not execute again. Inspect the destination for the result.",
        }
      }
      await this.deliver(request.id, directory, { fingerprint, result })
    } catch (error) {
      if (controller.signal.aborted) return
      const detail = error instanceof Error ? error.message : String(error)
      const message = state.completed
        ? `Browser action completed but its result could not be retained. It will not be replayed. Inspect the destination. ${detail}`
        : detail
      receipt.failure = {
        code:
          request.operation === "navigate"
            ? "navigation_failed"
            : request.operation === "evaluate"
              ? "evaluation_failed"
              : "invalid_request",
        message: message.slice(0, 10_000),
      }
      await this.deliver(request.id, directory, receipt)
    } finally {
      if (this.active.get(request.id) === controller) this.active.delete(request.id)
    }
  }

  private async deliver(requestID: string, directory: string, receipt: Receipt): Promise<void> {
    try {
      const client = this.connection.getClient().kilocode.browser
      const response = receipt.result
        ? await client.reply({ requestID, directory, result: receipt.result })
        : await client.reject({ requestID, directory, error: receipt.failure! })
      if (response.error)
        console.error("[Raya] Browser result delivery failed; retained receipt prevents replay:", response.error)
    } catch (error) {
      console.error("[Raya] Browser result delivery failed; retained receipt prevents replay:", error)
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
    this.receipts.clear()
  }
}
