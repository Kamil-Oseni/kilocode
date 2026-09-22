import { createHash } from "node:crypto"
import type {
  DesktopFailure,
  DesktopRequest,
  DesktopResult,
  EventKilocodeDesktopCancelled,
  EventKilocodeDesktopRequested,
  KiloClient,
} from "@kilocode/sdk/v2/client"
import type { ConnectionState } from "../cli-backend/connection-service"
import type { SSEPayload } from "../cli-backend/sdk-sse-adapter"
import type { DesktopSession } from "./desktop-session"

export interface DesktopConnection {
  onEvent(listener: (event: SSEPayload, directory?: string) => void): () => void
  onStateChange(listener: (state: ConnectionState, error?: Error) => void): () => void
  getKnownDirectories(): string[]
  getClient(): KiloClient
}

type Receipt = { fingerprint: string; result?: DesktopResult; failure?: DesktopFailure; delivered?: boolean }
type CaptureRequest = Extract<DesktopRequest, { operation: "observe" | "watch" }>
type ActionRequest = Exclude<DesktopRequest, CaptureRequest>
type ActionResult = Exclude<DesktopResult, { operation: "observe" | "watch" }>
type Frame = Awaited<ReturnType<DesktopSession["observe"]>>

const journal = "raya.computerUse.desktop.actionReceipts.v1"
const actions = new Set(["move", "drag", "click", "type", "key", "scroll"])

export interface DesktopReceiptStore {
  get<T>(key: string): T | undefined
  update(key: string, value: unknown): Thenable<void>
}

export class DesktopBridge {
  private readonly active = new Map<string, AbortController>()
  private readonly receipts = new Map<string, Receipt>()
  private readonly offEvent: () => void
  private readonly offState: () => void
  private writes = Promise.resolve()
  private revision = 0
  private disposed = false

  constructor(
    private readonly connection: DesktopConnection,
    private readonly session: DesktopSession,
    private readonly capture: (request: CaptureRequest, signal: AbortSignal) => Promise<Frame[]>,
    private readonly store?: DesktopReceiptStore,
  ) {
    this.restore()
    this.offEvent = connection.onEvent((event, directory) => this.event(event, directory))
    this.offState = connection.onStateChange((state) => this.state(state))
  }

  private event(event: SSEPayload, directory?: string): void {
    const value = event as unknown as EventKilocodeDesktopRequested | EventKilocodeDesktopCancelled
    if (value.type === "kilocode.desktop.cancelled") {
      const controller = this.active.get(value.properties.requestID)
      controller?.abort()
      this.active.delete(value.properties.requestID)
      if (controller) this.session.takeControl("The agent desktop observation was cancelled.")
      return
    }
    if (value.type !== "kilocode.desktop.requested" || !directory) return
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
      const response = await this.connection.getClient().kilocode.desktop.list({ directory })
      if (response.error) continue
      for (const request of response.data ?? []) void this.run(request, directory, true)
    }
  }

  private async run(request: DesktopRequest, directory: string, recovered = false): Promise<void> {
    if (this.disposed || this.active.has(request.id)) return
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([directory, request]))
      .digest("hex")
    const prior = this.receipts.get(request.id)
    if (prior && prior.fingerprint !== fingerprint) {
      await this.deliver(request.id, directory, {
        fingerprint,
        failure: { code: "invalid_request", message: "Desktop request ID was reused with different content." },
      })
      return
    }
    if (prior) {
      await this.deliver(request.id, directory, prior)
      return
    }
    this.compact()
    if (this.receipts.size >= 256) {
      await this.deliver(request.id, directory, {
        fingerprint,
        failure: { code: "invalid_request", message: "Desktop receipt capacity reached; no capture was performed." },
      })
      return
    }
    const receipt: Receipt = {
      fingerprint,
      failure: {
        code: "cancelled",
        message: "This desktop request was admitted but its outcome is unconfirmed. It will not be replayed.",
      },
    }
    this.receipts.set(request.id, receipt)
    if (recovered) {
      receipt.failure = {
        code: "invalid_request",
        message: "Recovered desktop request has no local receipt. Its prior outcome is unknown and was not replayed.",
      }
      await this.deliver(request.id, directory, receipt)
      return
    }
    const controller = new AbortController()
    const startedAt = Date.now()
    this.active.set(request.id, controller)
    try {
      const result =
        request.operation === "observe" || request.operation === "watch"
          ? await this.observe(request, startedAt, controller.signal)
          : await this.interact(request, startedAt)
      if (controller.signal.aborted) return
      receipt.result = result
      receipt.failure = undefined
      await this.retain(receipt).catch((error) =>
        console.error("[Raya] Desktop receipt persistence failed; backend delivery will still be attempted", error),
      )
      await this.deliver(request.id, directory, receipt)
    } catch (error) {
      if (controller.signal.aborted) return
      receipt.failure = {
        code: "invalid_request",
        message: (error instanceof Error ? error.message : String(error)).slice(0, 10_000),
        receipt: {
          version: 1,
          requestID: request.id,
          startedAt,
          finishedAt: Date.now(),
          effect: request.operation === "observe" || request.operation === "watch" ? "observe" : "interact",
          outcome: "unknown",
          ...(request.operation !== "observe" && request.operation !== "watch"
            ? {
                target: { surface: "desktop" as const, windowID: request.windowID },
                observationID: request.observationID,
              }
            : {}),
        },
      }
      await this.deliver(request.id, directory, receipt)
    } finally {
      if (this.active.get(request.id) === controller) this.active.delete(request.id)
    }
  }

  private async observe(request: CaptureRequest, startedAt: number, signal: AbortSignal): Promise<DesktopResult> {
    const frames = await this.capture(request, signal)
    if (request.operation === "watch") {
      const last = frames.at(-1)
      if (frames.length !== request.frameCount || !last)
        throw new Error("Desktop watch returned an incomplete frame sequence")
      return {
        operation: "watch",
        frames,
        receipt: {
          version: 1,
          requestID: request.id,
          startedAt,
          finishedAt: Date.now(),
          effect: "observe",
          outcome: "confirmed",
          target: last.observation.target,
          observationID: last.observation.id,
        },
      }
    }
    const frame = frames[0]
    if (!frame || frames.length !== 1) throw new Error("Desktop observation returned an invalid frame sequence")
    return {
      operation: "observe",
      width: frame.width,
      height: frame.height,
      mime: frame.mime,
      data: frame.data,
      observation: frame.observation,
      receipt: {
        version: 1,
        requestID: request.id,
        startedAt,
        finishedAt: Date.now(),
        effect: "observe",
        outcome: "confirmed",
        target: frame.observation.target,
        observationID: frame.observation.id,
      },
    }
  }

  private async interact(request: ActionRequest, startedAt: number): Promise<DesktopResult> {
    const receipt = {
      version: 1 as const,
      requestID: request.id,
      startedAt,
      finishedAt: 0,
      effect: "interact" as const,
      outcome: "confirmed" as const,
      target: { surface: "desktop" as const, windowID: request.windowID },
      observationID: request.observationID,
    }
    if (request.operation === "move") {
      await this.session.execute({
        operation: "pointer",
        action: "move",
        windowID: request.windowID,
        observationID: request.observationID,
        x: request.x,
        y: request.y,
      })
      return { operation: "move", receipt: { ...receipt, finishedAt: Date.now() } }
    }
    if (request.operation === "drag") {
      await this.session.execute({
        operation: "drag",
        windowID: request.windowID,
        observationID: request.observationID,
        startX: request.startX,
        startY: request.startY,
        endX: request.endX,
        endY: request.endY,
        button: request.button,
      })
      return { operation: "drag", receipt: { ...receipt, finishedAt: Date.now() } }
    }
    if (request.operation === "click") {
      await this.session.execute({
        operation: "pointer",
        action: request.action,
        windowID: request.windowID,
        observationID: request.observationID,
        x: request.x,
        y: request.y,
        button: request.button,
      })
      return { operation: "click", receipt: { ...receipt, finishedAt: Date.now() } }
    }
    if (request.operation === "type") {
      await this.session.execute({
        operation: "type",
        windowID: request.windowID,
        observationID: request.observationID,
        text: request.text,
      })
      return { operation: "type", receipt: { ...receipt, finishedAt: Date.now() } }
    }
    if (request.operation === "key") {
      await this.session.execute({
        operation: "key",
        windowID: request.windowID,
        observationID: request.observationID,
        key: request.key,
        modifiers: request.modifiers,
      })
      return { operation: "key", receipt: { ...receipt, finishedAt: Date.now() } }
    }
    await this.session.execute({
      operation: "scroll",
      windowID: request.windowID,
      observationID: request.observationID,
      deltaX: request.deltaX,
      deltaY: request.deltaY,
    })
    return { operation: "scroll", receipt: { ...receipt, finishedAt: Date.now() } }
  }

  private async deliver(requestID: string, directory: string, receipt: Receipt): Promise<void> {
    try {
      const client = this.connection.getClient().kilocode.desktop
      const response = receipt.result
        ? await client.reply({ requestID, directory, result: receipt.result })
        : await client.reject({ requestID, directory, error: receipt.failure! })
      if (response.error || response.data !== true) {
        console.error("[Raya] Desktop result delivery failed; retained receipt prevents replay")
        return
      }
      if (this.receipts.get(requestID) !== receipt) return
      receipt.delivered = true
      await this.retain(receipt).catch((error) =>
        console.error("[Raya] Desktop receipt acknowledgement persistence failed; stale receipt remains safe", error),
      )
    } catch (error) {
      console.error("[Raya] Desktop result delivery failed; retained receipt prevents replay", error)
    }
  }

  private compact(): void {
    if (this.receipts.size < 256) return
    for (const [id, receipt] of this.receipts) {
      if (!receipt.delivered) continue
      this.receipts.delete(id)
      if (this.receipts.size < 256) return
    }
  }

  private restore(): void {
    const saved = this.store?.get<unknown>(journal)
    if (!saved || typeof saved !== "object") return
    const value = saved as { version?: unknown; items?: unknown }
    if (value.version !== 1 || !Array.isArray(value.items) || value.items.length > 256) return
    for (const item of value.items) {
      if (!item || typeof item !== "object") continue
      const entry = item as { id?: unknown; fingerprint?: unknown; result?: unknown }
      if (
        typeof entry.id !== "string" ||
        !entry.id ||
        entry.id.length > 256 ||
        typeof entry.fingerprint !== "string" ||
        !/^[a-f0-9]{64}$/.test(entry.fingerprint) ||
        !persistable(entry.result) ||
        entry.result.receipt.requestID !== entry.id
      )
        continue
      this.receipts.set(entry.id, { fingerprint: entry.fingerprint, result: entry.result })
    }
  }

  private retain(receipt: Receipt): Promise<void> {
    if (!this.store || !receipt.result || !persistable(receipt.result)) return Promise.resolve()
    this.writes = this.writes.then(() => {
      const items = [...this.receipts.entries()]
        .filter(
          (entry): entry is [string, Receipt & { result: ActionResult }] =>
            !entry[1].delivered && persistable(entry[1].result),
        )
        .map(([key, value]) => ({ id: key, fingerprint: value.fingerprint, result: value.result }))
        .slice(-256)
      return Promise.resolve(this.store!.update(journal, { version: 1, items }))
    })
    return this.writes
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

function persistable(value: unknown): value is ActionResult {
  if (!value || typeof value !== "object") return false
  const result = value as { operation?: unknown; receipt?: unknown }
  if (typeof result.operation !== "string" || !actions.has(result.operation)) return false
  if (!result.receipt || typeof result.receipt !== "object") return false
  const receipt = result.receipt as Record<string, unknown>
  return (
    receipt.version === 1 &&
    typeof receipt.requestID === "string" &&
    Number.isFinite(receipt.startedAt) &&
    Number.isFinite(receipt.finishedAt) &&
    receipt.effect === "interact" &&
    receipt.outcome === "confirmed" &&
    typeof receipt.observationID === "string" &&
    !!receipt.target &&
    typeof receipt.target === "object" &&
    (receipt.target as Record<string, unknown>).surface === "desktop" &&
    typeof (receipt.target as Record<string, unknown>).windowID === "string"
  )
}
